/**
 * Compound III — calculador do tamanho ótimo do flashloan pra liquidation.
 *
 * Diferença chave vs Aave: usamos `Comet.quoteCollateral(asset, baseAmount)` on-chain
 * pra saber EXATAMENTE quanto collateral receberíamos por X de base token (já com
 * desconto de liquidação aplicado pelo protocolo). Mais preciso que o cálculo manual
 * de bonus do Aave — por isso NÃO precisamos converter via oracle aqui (Comet faz isso).
 *
 * Mas USD conversions (profit, gas, threshold) sim usam Aave V3 PriceOracle:
 *  - Base tokens do Compound em Base (USDC, WETH) também existem no Aave oracle ✓
 *  - Antes assumia stable-peg pra TUDO (B-1, B-3 do audit 2026-05-26)
 *
 * Algoritmo:
 *   1. Cap superior = min(collateralBalance × liquidationFactor, contractCap, poolCap)
 *   2. Sample logarítmico de baseAmounts entre $10 e cap
 *   3. Pra cada: quoteCollateral → swap sim via UniV3 → profit_líquido
 *   4. Refinamento local
 *   5. Valida MIN_LIQUIDATION_PROFIT_USD
 */

import type { Address, PublicClient } from 'viem';
import { quoteUniswapV3, isQuote } from '@zeus-evm/dex-adapters';
import type { Quote } from '@zeus-evm/dex-adapters';

import type { LiquidatorEnv } from '../../config';
import type {
  CompoundLiquidatablePosition,
  LiquidationOutcome,
  LiquidationDecision,
} from '../../types';
import { logger } from '../../logger';
import { cachedQuoteUniswapV3 } from '@zeus-evm/execution-utils';
import { FlashSource } from '../../types';
import { COMET_ABI } from './abi';
import { AavePriceOracle, usdToWei, weiToUsd } from '../aave/oracle';

type AnyPublicClient = PublicClient<any, any>;

const UNI_V3_FEE_TIERS = [500, 3000, 100, 10000];
const AAVE_FLASHLOAN_PREMIUM_BPS = 5n;
const BPS_DENOMINATOR = 10_000n;

// Bonus de liquidação Compound (~1% pra absorbed assets). Usado pra calcular
// expectedNoSlippage como proxy do "ideal sem perda".
const COMPOUND_LIQUIDATION_BONUS_BPS = 100n; // 1%

// Safe range pra log-sample em Number (B-5 fix)
const SAFE_NUMBER_BITS = 50n;
const SAFE_NUMBER_MAX = 1n << SAFE_NUMBER_BITS;

export interface CompoundCalculatorOpts {
  env: LiquidatorEnv;
  client: AnyPublicClient;
  quoterAddress: Address;
  contractCapWei: bigint;
  /** Oracle pra converter USD ↔ base token wei (gas, threshold, profit). */
  oracle: AavePriceOracle;
}

/**
 * Calcula tamanho ótimo do baseAmount (que vira flashloan) pra uma Compound position.
 */
export async function calculateOptimalCompoundLiquidation(
  position: CompoundLiquidatablePosition,
  opts: CompoundCalculatorOpts,
): Promise<LiquidationOutcome> {
  const { env, client, quoterAddress, contractCapWei, oracle } = opts;

  // 0) Preço base token (Compound base = USDC ou WETH em Base; ambos no Aave oracle).
  const basePrice = await oracle.getAssetPrice(position.baseToken);
  if (basePrice === 0n) {
    return { ok: false, reason: `oracle não retornou preço pra ${position.baseTokenSymbol}` };
  }

  // 1) Cap superior. Pra Compound, "cap natural" = quanto baseToken precisaríamos pra
  // consumir TODO o collateral do borrower. Isso seria valor_collateral × liquidationFactor
  // em wei do baseToken — mas Comet.quoteCollateral rejeita amounts >cap, então usamos
  // contractCap como ceiling defensivo.
  const upperBound = contractCapWei;
  // Mínimo absoluto em base wei via oracle (B-3 fix).
  const minBaseWei = usdToWei(Math.max(1, env.MIN_DEBT_USD), basePrice, position.baseTokenDecimals);
  if (minBaseWei === 0n) {
    return { ok: false, reason: 'minBaseWei calculado como 0 (oracle inválido)' };
  }
  if (upperBound < minBaseWei) {
    return { ok: false, reason: `upperBound ${upperBound} < $${env.MIN_DEBT_USD} mínimo` };
  }

  // 2) Sample logarítmico — escalado pra Number safe range (B-5 fix)
  const sampled: Array<{ L: bigint; profit: bigint; slippageBps: number }> = [];
  const { lo, hi, shift } = scaleToSafeRange(minBaseWei, upperBound);
  const upperF = Number(hi);
  const lowerF = Number(lo);
  for (let i = 0; i < 10; i++) {
    let L = BigInt(Math.floor(lowerF * Math.pow(upperF / lowerF, i / 9)));
    if (shift > 0n) L = L << shift;
    const sim = await simulateCompoundProfit(L, position, opts, basePrice);
    if (sim !== null) sampled.push({ L, ...sim });
  }

  if (sampled.length === 0) {
    return { ok: false, reason: 'nenhum baseAmount produziu quote válido' };
  }

  let best = sampled[0]!;
  for (const c of sampled) {
    if (c.profit > best.profit) best = c;
  }

  // 3) Refinamento local
  const window = best.L / 5n;
  if (window > 0n) {
    for (let i = 0; i < 5; i++) {
      const offset = (BigInt(i) * 2n * window) / 4n;
      const L = best.L > window + offset ? best.L - window + offset : minBaseWei;
      if (L > upperBound) continue;
      const sim = await simulateCompoundProfit(L, position, opts, basePrice);
      if (sim !== null && sim.profit > best.profit) {
        best = { L, ...sim };
      }
    }
  }

  // 4) Sanity profit threshold via oracle (B-1 + B-3 fix)
  const minProfitWei = usdToWei(env.MIN_LIQUIDATION_PROFIT_USD, basePrice, position.baseTokenDecimals);
  if (best.profit < minProfitWei) {
    return {
      ok: false,
      reason: `profit ${formatWei(best.profit, position.baseTokenDecimals)} < threshold $${env.MIN_LIQUIDATION_PROFIT_USD}`,
    };
  }

  const profitUsd = weiToUsd(best.profit, basePrice, position.baseTokenDecimals);

  const decision: LiquidationDecision = {
    flashloanAmount: best.L,
    expectedProfitWei: best.profit,
    expectedProfitUsd: profitUsd,
    estimatedSlippageBps: best.slippageBps,
    minProfitWei: (best.profit * 7n) / 10n,
    // Default Aave; pipeline sobrescreve via seletor de fonte 0% quando há liquidez.
    flashSource: FlashSource.Aave,
    flashPremiumBps: AAVE_FLASHLOAN_PREMIUM_BPS,
  };

  logger.info(
    {
      comet: position.cometName,
      borrower: position.borrower,
      baseAmountWei: best.L.toString(),
      profitUsd: profitUsd.toFixed(2),
      slippageBps: best.slippageBps,
      basePriceUsd: (Number(basePrice) / 1e8).toFixed(4),
    },
    `💡 Compound decision: ${position.cometName} liquidate ${position.borrower.slice(0, 10)} base=${formatWei(best.L, position.baseTokenDecimals)} ${position.baseTokenSymbol}`,
  );

  return { ok: true, decision };
}

/**
 * Simula profit pra um baseAmount via Comet.quoteCollateral + UniV3 swap sim.
 */
async function simulateCompoundProfit(
  baseAmount: bigint,
  position: CompoundLiquidatablePosition,
  opts: CompoundCalculatorOpts,
  basePrice: bigint,
): Promise<{ profit: bigint; slippageBps: number } | null> {
  const { client, quoterAddress, env } = opts;

  // 1. quoteCollateral on-chain — quanto collateral receberíamos? (já com desconto)
  let collateralReceived: bigint;
  try {
    collateralReceived = (await client.readContract({
      address: position.comet,
      abi: COMET_ABI,
      functionName: 'quoteCollateral',
      args: [position.collateralAsset, baseAmount],
    })) as bigint;
  } catch {
    return null;
  }

  if (collateralReceived === 0n) return null;

  // 2. Validar que o borrower tem collateral suficiente
  if (collateralReceived > position.collateralBalanceWei) {
    // baseAmount é maior que o que dá pra absorver. Cap natural atingido.
    return null;
  }

  // 3. Simular swap collateral → baseToken (via cache)
  let bestQuote: Quote | null = null;
  for (const fee of UNI_V3_FEE_TIERS) {
    const q = await cachedQuoteUniswapV3(
      {
        client,
        quoterAddress,
        tokenIn: position.collateralAsset,
        tokenOut: position.baseToken,
        amountIn: collateralReceived,
        fee,
        decimalsIn: position.collateralAssetDecimals,
        decimalsOut: position.baseTokenDecimals,
      },
      quoteUniswapV3,
    );
    if (isQuote(q) && (!bestQuote || q.amountOut > bestQuote.amountOut)) bestQuote = q;
  }

  if (!bestQuote) return null;

  // 4. Custos: flashloan fee + gas (B-3 fix: gas via oracle)
  const flashloanFee = (baseAmount * AAVE_FLASHLOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
  const gasCostWei = usdToWei(env.GAS_COST_USD_ESTIMATE, basePrice, position.baseTokenDecimals);

  // 5. Slippage check (B-4 fix: precedência operadores)
  // Antes: `(baseAmount * BPS_DENOMINATOR + 100n) / BPS_DENOMINATOR` → soma 0 wei
  // Agora: `(baseAmount * (BPS_DENOMINATOR + bonus)) / BPS_DENOMINATOR` → soma bonus correto
  const expectedNoSlippage =
    (baseAmount * (BPS_DENOMINATOR + COMPOUND_LIQUIDATION_BONUS_BPS)) / BPS_DENOMINATOR;
  const slippageBps = expectedNoSlippage > bestQuote.amountOut
    ? Number(((expectedNoSlippage - bestQuote.amountOut) * BPS_DENOMINATOR) / expectedNoSlippage)
    : 0;
  if (slippageBps > env.MAX_SLIPPAGE_BPS) return null;

  const profit = bestQuote.amountOut > baseAmount + flashloanFee + gasCostWei
    ? bestQuote.amountOut - baseAmount - flashloanFee - gasCostWei
    : 0n;

  return { profit, slippageBps };
}

/**
 * Escala lo/hi pra caber em Number.MAX_SAFE_INTEGER (B-5 fix).
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
