/**
 * Aave V3 — calculador do tamanho ótimo do flashloan pra liquidation.
 *
 * Algoritmo (caminho A — conservador, sem mempool watching):
 *   1. Determinar cap superior natural:
 *      - protocolCap = totalDebt × closeFactor (Aave: max 50%)
 *      - poolCap     = poolLiquidity × POOL_LIQUIDITY_CAP_PCT (default 10%)
 *      - contractCap = getMaxTradeFor(debtAsset) on-chain
 *      → upperBound = min(os 3)
 *   2. Sample logarítmico: 10 amounts entre lower (10 USD) e upper
 *   3. Pra cada amount L, calcular profit_líquido(L):
 *      profit = swap_output(L × (1+bonus) × oraclePriceRatio) − L − L×0.0005 − gas
 *   4. Refinar: 5 amounts em torno do melhor da fase 2
 *   5. Validar profit > MIN_LIQUIDATION_PROFIT_USD → senão descarta
 *
 * Conversões USD: usam Aave V3 PriceOracle (oracle.ts). Antes assumia stable-peg
 * (B-1, B-2, B-3 do audit 2026-05-26).
 *
 * Latência típica: ~750ms (15 calls × ~50ms) em RPC normal. Com cache de slippage curves
 * por pool + cache de oracle prices by-block, cai pra ~150-250ms.
 */

import type { Address, PublicClient } from 'viem';
import {
  quoteUniswapV3,
  quoteUniswapV3MultiHop,
  buildCandidateRoutes,
  bestSwapAcrossDexes,
  isQuote,
  type Quote,
} from '@zeus-evm/dex-adapters';
import type { ChainConfig } from '@zeus-evm/chain-config';

import type { LiquidatorEnv } from '../../config';
import type {
  AaveLiquidatablePosition,
  LiquidationOutcome,
  LiquidationDecision,
  SwapPlan,
} from '../../types';
import { resolveBestSwapPlan } from '../bestSwapPlan';
import { logger } from '../../logger';
import { cachedQuoteUniswapV3 } from '@zeus-evm/execution-utils';
import { FlashSource } from '../../types';
import { AavePriceOracle, convertWeiByPrice, usdToWei, weiToUsd } from './oracle';

type AnyPublicClient = PublicClient<any, any>;

// Fee tiers UniV3 a tentar (ordem do mais comum em pools profundos)
const UNI_V3_FEE_TIERS = [500, 3000, 100, 10000];

// Aave V3 flashloan premium (immutable feature do protocolo)
const AAVE_FLASHLOAN_PREMIUM_BPS = 5n; // 0.05%
const BPS_DENOMINATOR = 10_000n;

// Safe range pra log-sample em Number — evita Number.MAX_SAFE_INTEGER overflow (B-5 fix)
const SAFE_NUMBER_BITS = 50n; // 2^50 ≈ 1.1e15, abaixo de MAX_SAFE_INTEGER (2^53)
const SAFE_NUMBER_MAX = 1n << SAFE_NUMBER_BITS;

export interface AaveCalculatorOpts {
  env: LiquidatorEnv;
  client: AnyPublicClient;
  quoterAddress: Address;
  /** Chain config — habilita o swap multi-DEX (UniV3/Aero/Slipstream). Ausente = só UniV3. */
  chainConfig?: ChainConfig;
  /** Cap on-chain via getMaxTradeFor(debtAsset). Override do protocolCap se menor. */
  contractCapWei: bigint;
  /** Aave PriceOracle pra conversões USD-corretas (debt/collateral/gas). */
  oracle: AavePriceOracle;
  /**
   * Tokens intermediários pra multi-hop swap routing (Grupo B).
   * Tipicamente [WETH, USDC] da chain. Vazio = só single-hop.
   */
  multiHopIntermediates?: readonly Address[];
}

/**
 * Calcula a decisão de tamanho ótimo pra uma position liquidável.
 * Retorna `LiquidationOutcome` discriminated: ok=true com decision, ok=false com razão.
 */
export async function calculateOptimalLiquidation(
  position: AaveLiquidatablePosition,
  opts: AaveCalculatorOpts,
): Promise<LiquidationOutcome> {
  const { env, client, quoterAddress, contractCapWei, oracle } = opts;

  // 0) Pré-busca preços (batched). Cache by-block evita N calls.
  const prices = await oracle.getAssetsPrices([position.debtAsset, position.collateralAsset]);
  const debtPrice = prices.get(position.debtAsset.toLowerCase());
  const collateralPrice = prices.get(position.collateralAsset.toLowerCase());
  if (!debtPrice || debtPrice === 0n) {
    return { ok: false, reason: `oracle não retornou preço pra debt ${position.debtAssetSymbol}` };
  }
  if (!collateralPrice || collateralPrice === 0n) {
    return { ok: false, reason: `oracle não retornou preço pra collateral ${position.collateralAssetSymbol}` };
  }

  // 1) Cap superior = mínimo dos 3 caps
  const protocolCap = (position.totalDebtWei * BigInt(Math.floor(env.AAVE_CLOSE_FACTOR * 10_000))) / 10_000n;
  const upperBound = protocolCap < contractCapWei ? protocolCap : contractCapWei;
  // Mínimo absoluto configurável (env.MIN_DEBT_USD).
  // Converte USD → debt wei via oracle (B-3 fix).
  const minDebtWei = usdToWei(Math.max(1, env.MIN_DEBT_USD), debtPrice, position.debtAssetDecimals);
  if (minDebtWei === 0n) {
    return { ok: false, reason: 'minDebtWei calculado como 0 (oracle inválido)' };
  }
  if (upperBound < minDebtWei) {
    return { ok: false, reason: `upperBound ${upperBound} < $${env.MIN_DEBT_USD} mínimo (${minDebtWei})` };
  }

  // 2) Sample logarítmico — 16 pontos entre min e upper (Grupo B: resolução
  // maior pra capturar ótimos em pools rasos onde profit curve é não-monotônica).
  // Escala downscale_shift até caber em Number safe range (B-5 fix).
  const sampledProfits: Array<{ L: bigint; profit: bigint; slippageBps: number }> = [];
  const { lo, hi, shift } = scaleToSafeRange(minDebtWei, upperBound);
  const upperFloat = Number(hi);
  const lowerFloat = Number(lo);
  const SAMPLE_COUNT = 16;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    let L = BigInt(Math.floor(lowerFloat * Math.pow(upperFloat / lowerFloat, i / (SAMPLE_COUNT - 1))));
    if (shift > 0n) L = L << shift;
    const sim = await simulateProfit(L, position, opts, debtPrice, collateralPrice);
    if (sim !== null) sampledProfits.push({ L, ...sim });
  }

  if (sampledProfits.length === 0) {
    return { ok: false, reason: 'nenhum amount produziu quote válido (pools sem liquidez?)' };
  }

  // 3) Pega melhor profit do sample
  let best = sampledProfits[0]!;
  for (const candidate of sampledProfits) {
    if (candidate.profit > best.profit) best = candidate;
  }

  // 4) Refinar local Fase 1: 9 amounts em janela ±40% em volta do melhor.
  // Grupo B: refinement mais agressivo cobre melhor pool com curva de profit íngreme.
  const window1 = (best.L * 2n) / 5n; // ±40%
  if (window1 > 0n) {
    const REFINE_POINTS_1 = 9;
    for (let i = 0; i < REFINE_POINTS_1; i++) {
      const offset = (BigInt(i) * 2n * window1) / BigInt(REFINE_POINTS_1 - 1);
      const L = best.L > window1 + offset ? best.L - window1 + offset : minDebtWei;
      if (L > upperBound) continue;
      const sim = await simulateProfit(L, position, opts, debtPrice, collateralPrice);
      if (sim !== null && sim.profit > best.profit) {
        best = { L, ...sim };
      }
    }
  }

  // 5) Refinar local Fase 2: 5 amounts em janela ±10% em volta do novo melhor.
  // Grupo B: zoom-in fino pra travar próximo do ótimo verdadeiro.
  const window2 = best.L / 10n;
  if (window2 > 0n) {
    const REFINE_POINTS_2 = 5;
    for (let i = 0; i < REFINE_POINTS_2; i++) {
      const offset = (BigInt(i) * 2n * window2) / BigInt(REFINE_POINTS_2 - 1);
      const L = best.L > window2 + offset ? best.L - window2 + offset : minDebtWei;
      if (L > upperBound) continue;
      const sim = await simulateProfit(L, position, opts, debtPrice, collateralPrice);
      if (sim !== null && sim.profit > best.profit) {
        best = { L, ...sim };
      }
    }
  }

  // Multi-DEX: no tamanho ótimo, escolhe o melhor venue (UniV3/Aero/Slipstream) pra a troca
  // colateral→dívida. Antes a pipeline chumbava UniV3 fee 500; agora executa o de melhor preço.
  // Roda ANTES do gate → o gate também ganha o melhor preço (não rejeita liquidação só-lucrativa-na-Aero).
  let chosenSwapPlan: SwapPlan | undefined;
  {
    const bonusFactor = BPS_DENOMINATOR + BigInt(position.liquidationBonusBps);
    const collateralAtBest = convertWeiByPrice(
      (best.L * bonusFactor) / BPS_DENOMINATOR,
      debtPrice,
      position.debtAssetDecimals,
      collateralPrice,
      position.collateralAssetDecimals,
    );
    const flashloanFee = (best.L * AAVE_FLASHLOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
    const gasCostWei = usdToWei(env.GAS_COST_USD_ESTIMATE, debtPrice, position.debtAssetDecimals);
    const swap = await resolveBestSwapPlan({
      client,
      chainConfig: opts.chainConfig,
      collateralAsset: position.collateralAsset,
      debtAsset: position.debtAsset,
      collateralDecimals: position.collateralAssetDecimals,
      debtDecimals: position.debtAssetDecimals,
      collateralAmount: collateralAtBest,
      repayAmount: best.L + flashloanFee,
      gasCostWei,
      priorProfit: best.profit,
    });
    chosenSwapPlan = swap.swapPlan;
    best = { ...best, profit: swap.profit };
  }

  // 5) Sanity: profit cobre MIN_LIQUIDATION_PROFIT_USD?
  // Converte threshold USD → debt wei via oracle (B-3 fix, era assume stable).
  const minProfitWei = usdToWei(env.MIN_LIQUIDATION_PROFIT_USD, debtPrice, position.debtAssetDecimals);
  if (best.profit < minProfitWei) {
    return {
      ok: false,
      reason: `profit ótimo ${formatWei(best.profit, position.debtAssetDecimals)} < threshold $${env.MIN_LIQUIDATION_PROFIT_USD}`,
    };
  }

  // expectedProfitUsd real via oracle (B-1 fix)
  const profitUsd = weiToUsd(best.profit, debtPrice, position.debtAssetDecimals);

  const decision: LiquidationDecision = {
    flashloanAmount: best.L,
    expectedProfitWei: best.profit,
    expectedProfitUsd: profitUsd,
    estimatedSlippageBps: best.slippageBps,
    minProfitWei: (best.profit * 7n) / 10n, // 70% do esperado como floor (margem de segurança)
    // Default conservador (Aave 0,05%). O pipeline pode sobrescrever via seletor de fonte 0%
    // (Morpho/Balancer) quando há liquidez — o profit estimado fica 5bps conservador, errando a favor.
    flashSource: FlashSource.Aave,
    flashPremiumBps: AAVE_FLASHLOAN_PREMIUM_BPS,
    swapPlan: chosenSwapPlan,
  };

  logger.info(
    {
      borrower: position.borrower,
      flashloanWei: best.L.toString(),
      profitUsd: profitUsd.toFixed(2),
      slippageBps: best.slippageBps,
      debtPriceUsd: (Number(debtPrice) / 1e8).toFixed(4),
      collateralPriceUsd: (Number(collateralPrice) / 1e8).toFixed(4),
    },
    `💡 Decision: liquidate ${position.borrower.slice(0, 10)} flashloan=${formatWei(best.L, position.debtAssetDecimals)} ${position.debtAssetSymbol}`,
  );

  return { ok: true, decision };
}

/**
 * Simula o profit pra um flashloan amount específico via Uniswap V3 QuoterV2.
 * Retorna null se não conseguir cotação (sem liquidez, etc).
 */
async function simulateProfit(
  L: bigint,
  position: AaveLiquidatablePosition,
  opts: AaveCalculatorOpts,
  debtPrice: bigint,
  collateralPrice: bigint,
): Promise<{ profit: bigint; slippageBps: number } | null> {
  // Quanto collateral receberíamos? L × (1 + bonus) — em USD value.
  // Convertendo correto via oracle (B-2 fix):
  //   collateralReceived = convertWeiByPrice(L × (1+bonus), debtPrice → collateralPrice)
  const bonusFactor = BPS_DENOMINATOR + BigInt(position.liquidationBonusBps);
  const debtWithBonus = (L * bonusFactor) / BPS_DENOMINATOR;
  const collateralReceived = convertWeiByPrice(
    debtWithBonus,
    debtPrice,
    position.debtAssetDecimals,
    collateralPrice,
    position.collateralAssetDecimals,
  );
  if (collateralReceived === 0n) return null;

  // Try múltiplos fee tiers (via cache), pega o melhor amountOut
  let bestQuote: Quote | null = null;
  for (const fee of UNI_V3_FEE_TIERS) {
    const q = await cachedQuoteUniswapV3(
      {
        client: opts.client,
        quoterAddress: opts.quoterAddress,
        tokenIn: position.collateralAsset,
        tokenOut: position.debtAsset,
        amountIn: collateralReceived,
        fee,
        decimalsIn: position.collateralAssetDecimals,
        decimalsOut: position.debtAssetDecimals,
      },
      quoteUniswapV3,
    );
    if (isQuote(q)) {
      if (!bestQuote || q.amountOut > bestQuote.amountOut) bestQuote = q;
    }
  }

  // Grupo B — Multi-hop routes (via WETH/USDC intermediates).
  // Útil quando pool direto collateral→debt é raso. Multi-chain ready: caller
  // passa intermediates do chain-config (Polygon: WMATIC+USDC, Avalanche: WAVAX+USDC).
  if (opts.multiHopIntermediates && opts.multiHopIntermediates.length > 0) {
    const routes = buildCandidateRoutes({
      tokenIn: position.collateralAsset,
      tokenOut: position.debtAsset,
      intermediates: opts.multiHopIntermediates,
      maxRoutes: 9,                                 // 3 single-hop testados acima já cobertos
    }).filter((r) => r.tokens.length > 2);          // só multi-hop aqui

    for (const route of routes) {
      const q = await quoteUniswapV3MultiHop({
        client: opts.client,
        quoterAddress: opts.quoterAddress,
        route,
        amountIn: collateralReceived,
        decimalsIn: position.collateralAssetDecimals,
        decimalsOut: position.debtAssetDecimals,
      });
      if (isQuote(q)) {
        if (!bestQuote || q.amountOut > bestQuote.amountOut) bestQuote = q;
      }
    }
  }

  if (!bestQuote) return null;

  // profit_líquido = swap_output − L − flashloan_fee − gas_cost
  const flashloanFee = (L * AAVE_FLASHLOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
  // gas cost em USD → debt wei via oracle (B-3 fix). Antes assumia 1 unit = $1.
  const gasCostWei = usdToWei(opts.env.GAS_COST_USD_ESTIMATE, debtPrice, position.debtAssetDecimals);

  // Slippage = (expected - actual) / expected em bps.
  // Expected ideal = `debtWithBonus` em debt wei (paridade USD perfeita pelo oracle).
  const slippageBps = debtWithBonus > bestQuote.amountOut
    ? Number(((debtWithBonus - bestQuote.amountOut) * BPS_DENOMINATOR) / debtWithBonus)
    : 0;

  // Slippage tolerance check
  if (slippageBps > opts.env.MAX_SLIPPAGE_BPS) return null;

  const profit = bestQuote.amountOut > L + flashloanFee + gasCostWei
    ? bestQuote.amountOut - L - flashloanFee - gasCostWei
    : 0n;

  return { profit, slippageBps };
}

/**
 * Escala lo/hi pra caber em Number.MAX_SAFE_INTEGER (~2^53) preservando ratio
 * pra log-sampling. Shift bits via `>>` (bigint), depois `<<` no resultado.
 *
 * Fix B-5: cap fallback 10^20 e flashloans grandes (1000 ETH = 10^21) excediam
 * MAX_SAFE_INTEGER → `Number(upperBound)` virava Infinity → BigInt(NaN) throw.
 */
function scaleToSafeRange(lo: bigint, hi: bigint): { lo: bigint; hi: bigint; shift: bigint } {
  let shift = 0n;
  while (hi > SAFE_NUMBER_MAX) {
    hi = hi >> 10n;
    lo = lo >> 10n;
    shift += 10n;
    if (lo === 0n) lo = 1n;
  }
  return { lo, hi, shift };
}

function formatWei(wei: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = wei / divisor;
  const fraction = wei % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, '0').slice(0, 4)}`;
}
