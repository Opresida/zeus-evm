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
 *      profit = swap_output(L × (1+bonus)) − L − L×0.0005 − gas
 *   4. Refinar: 5 amounts em torno do melhor da fase 2
 *   5. Validar profit > MIN_LIQUIDATION_PROFIT_USD → senão descarta
 *
 * Latência típica: ~750ms (15 calls × ~50ms) em RPC normal. Com cache de slippage curves
 * por pool, cai pra ~150-250ms. Por enquanto sem cache.
 */

import type { Address, PublicClient } from 'viem';
import { quoteUniswapV3, isQuote } from '@zeus-evm/dex-adapters';
import type { Quote } from '@zeus-evm/dex-adapters';

import type { LiquidatorEnv } from '../../config';
import type {
  AaveLiquidatablePosition,
  LiquidationOutcome,
  LiquidationDecision,
} from '../../types';
import { logger } from '../../logger';
import { cachedQuoteUniswapV3 } from '../../slippageCache';

type AnyPublicClient = PublicClient<any, any>;

// Fee tiers UniV3 a tentar (ordem do mais comum em pools profundos)
const UNI_V3_FEE_TIERS = [500, 3000, 100, 10000];

// Aave V3 flashloan premium (immutable feature do protocolo)
const AAVE_FLASHLOAN_PREMIUM_BPS = 5n; // 0.05%
const BPS_DENOMINATOR = 10_000n;

export interface AaveCalculatorOpts {
  env: LiquidatorEnv;
  client: AnyPublicClient;
  quoterAddress: Address;
  /** Cap on-chain via getMaxTradeFor(debtAsset). Override do protocolCap se menor. */
  contractCapWei: bigint;
}

/**
 * Calcula a decisão de tamanho ótimo pra uma position liquidável.
 * Retorna `LiquidationOutcome` discriminated: ok=true com decision, ok=false com razão.
 */
export async function calculateOptimalLiquidation(
  position: AaveLiquidatablePosition,
  opts: AaveCalculatorOpts,
): Promise<LiquidationOutcome> {
  const { env, client, quoterAddress, contractCapWei } = opts;

  // 1) Cap superior = mínimo dos 3 caps
  const protocolCap = (position.totalDebtWei * BigInt(Math.floor(env.AAVE_CLOSE_FACTOR * 10_000))) / 10_000n;
  const upperBound = protocolCap < contractCapWei ? protocolCap : contractCapWei;
  // Mínimo absoluto configurável (env.MIN_DEBT_USD). Default 100 = $100 pra produção.
  // Clamp em >= 1 unidade pra evitar div-by-zero no sample logarítmico (BigInt(NaN)).
  const minDebtMultiplier = BigInt(Math.max(1, Math.floor(env.MIN_DEBT_USD)));
  const minDebtWei = minDebtMultiplier * 10n ** BigInt(position.debtAssetDecimals);
  if (upperBound < minDebtWei) {
    return { ok: false, reason: `upperBound ${upperBound} < $${env.MIN_DEBT_USD} mínimo (${minDebtWei})` };
  }

  // 2) Sample logarítmico — 10 pontos entre min e upper
  const sampledProfits: Array<{ L: bigint; profit: bigint; slippageBps: number }> = [];
  const upperFloat = Number(upperBound);
  const lowerFloat = Number(minDebtWei);
  for (let i = 0; i < 10; i++) {
    const L = BigInt(Math.floor(lowerFloat * Math.pow(upperFloat / lowerFloat, i / 9)));
    const sim = await simulateProfit(L, position, opts);
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

  // 4) Refinar local: 5 amounts em janela ±20% em volta do melhor
  const window = best.L / 5n;
  if (window > 0n) {
    for (let i = 0; i < 5; i++) {
      const offset = (BigInt(i) * 2n * window) / 4n;
      const L = best.L > window + offset ? best.L - window + offset : minDebtWei;
      if (L > upperBound) continue;
      const sim = await simulateProfit(L, position, opts);
      if (sim !== null && sim.profit > best.profit) {
        best = { L, ...sim };
      }
    }
  }

  // 5) Sanity: profit cobre MIN_LIQUIDATION_PROFIT_USD?
  const minProfitWei = BigInt(env.MIN_LIQUIDATION_PROFIT_USD) * 10n ** BigInt(position.debtAssetDecimals);
  if (best.profit < minProfitWei) {
    return {
      ok: false,
      reason: `profit ótimo ${formatWei(best.profit, position.debtAssetDecimals)} < threshold $${env.MIN_LIQUIDATION_PROFIT_USD}`,
    };
  }

  const decision: LiquidationDecision = {
    flashloanAmount: best.L,
    expectedProfitWei: best.profit,
    expectedProfitUsd: Number(best.profit) / 10 ** position.debtAssetDecimals,
    estimatedSlippageBps: best.slippageBps,
    minProfitWei: (best.profit * 7n) / 10n, // 70% do esperado como floor (margem de segurança)
  };

  logger.info(
    {
      borrower: position.borrower,
      flashloanWei: best.L.toString(),
      flashloanUsd: decision.expectedProfitUsd.toFixed(2),
      profitUsd: decision.expectedProfitUsd.toFixed(2),
      slippageBps: best.slippageBps,
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
): Promise<{ profit: bigint; slippageBps: number } | null> {
  // Quanto collateral receberíamos? L × (1 + bonus)
  // Mas L é em debtAsset e collateralReceived é em collateralAsset wei
  // → precisamos do oracle price pra conversão correta.
  //
  // Aproximação MVP (caminho A): assume stable-peg em ambos. Refinar via oracle on-chain
  // antes de mainnet (TODO documentado).
  //
  // collateralReceived_em_collateralAsset_wei = L × (1+bonus) × 10^(decimalsCollateral-decimalsDebt)
  const bonusFactor = BPS_DENOMINATOR + BigInt(position.liquidationBonusBps);
  const decimalDiff = position.collateralAssetDecimals - position.debtAssetDecimals;
  let collateralReceived = (L * bonusFactor) / BPS_DENOMINATOR;
  if (decimalDiff > 0) {
    collateralReceived = collateralReceived * 10n ** BigInt(decimalDiff);
  } else if (decimalDiff < 0) {
    collateralReceived = collateralReceived / 10n ** BigInt(-decimalDiff);
  }

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

  if (!bestQuote) return null;

  // profit_líquido = swap_output − L − flashloan_fee − gas_cost
  const flashloanFee = (L * AAVE_FLASHLOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
  const gasCostWei = BigInt(Math.floor(opts.env.GAS_COST_USD_ESTIMATE)) *
    10n ** BigInt(position.debtAssetDecimals); // assume gas em USD ≈ debt asset USD

  // Slippage = (expected - actual) / expected em bps. Expected = L × (1+bonus) (paridade ideal).
  const expectedNoSlippage = (L * bonusFactor) / BPS_DENOMINATOR;
  const slippageBps = expectedNoSlippage > bestQuote.amountOut
    ? Number(((expectedNoSlippage - bestQuote.amountOut) * BPS_DENOMINATOR) / expectedNoSlippage)
    : 0;

  // Slippage tolerance check
  if (slippageBps > opts.env.MAX_SLIPPAGE_BPS) return null;

  const profit = bestQuote.amountOut > L + flashloanFee + gasCostWei
    ? bestQuote.amountOut - L - flashloanFee - gasCostWei
    : 0n;

  return { profit, slippageBps };
}

function formatWei(wei: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = wei / divisor;
  const fraction = wei % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, '0').slice(0, 4)}`;
}
