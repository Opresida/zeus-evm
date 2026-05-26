/**
 * Compound III — calculador do tamanho ótimo do flashloan pra liquidation.
 *
 * Diferença chave vs Aave: usamos `Comet.quoteCollateral(asset, baseAmount)` on-chain
 * pra saber EXATAMENTE quanto collateral receberíamos por X de base token (já com
 * desconto de liquidação aplicado pelo protocolo). Mais preciso que o cálculo manual
 * de bonus do Aave.
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
import { COMET_ABI } from './abi';

type AnyPublicClient = PublicClient<any, any>;

const UNI_V3_FEE_TIERS = [500, 3000, 100, 10000];
const AAVE_FLASHLOAN_PREMIUM_BPS = 5n;
const BPS_DENOMINATOR = 10_000n;

export interface CompoundCalculatorOpts {
  env: LiquidatorEnv;
  client: AnyPublicClient;
  quoterAddress: Address;
  contractCapWei: bigint;
}

/**
 * Calcula tamanho ótimo do baseAmount (que vira flashloan) pra uma Compound position.
 */
export async function calculateOptimalCompoundLiquidation(
  position: CompoundLiquidatablePosition,
  opts: CompoundCalculatorOpts,
): Promise<LiquidationOutcome> {
  const { env, client, quoterAddress, contractCapWei } = opts;

  // 1) Cap superior. Pra Compound, "cap natural" = quanto baseToken precisaríamos pra
  // consumir TODO o collateral do borrower. Isso seria valor_collateral × liquidationFactor
  // em wei do baseToken — mas pra evitar oracle call, usamos contractCap como ceiling seguro.
  const upperBound = contractCapWei;
  // Mínimo configurável via env.MIN_DEBT_USD (default 100). Clamp >= 1 unit pra evitar
  // div-by-zero (BigInt(NaN)) no sample logarítmico quando MIN_DEBT_USD < 1.
  const minBaseMultiplier = BigInt(Math.max(1, Math.floor(env.MIN_DEBT_USD)));
  const minBaseWei = minBaseMultiplier * 10n ** BigInt(position.baseTokenDecimals);
  if (upperBound < minBaseWei) {
    return { ok: false, reason: `upperBound ${upperBound} < $${env.MIN_DEBT_USD} mínimo` };
  }

  // 2) Sample logarítmico
  const sampled: Array<{ L: bigint; profit: bigint; slippageBps: number }> = [];
  const upperF = Number(upperBound);
  const lowerF = Number(minBaseWei);
  for (let i = 0; i < 10; i++) {
    const L = BigInt(Math.floor(lowerF * Math.pow(upperF / lowerF, i / 9)));
    const sim = await simulateCompoundProfit(L, position, opts);
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
      const sim = await simulateCompoundProfit(L, position, opts);
      if (sim !== null && sim.profit > best.profit) {
        best = { L, ...sim };
      }
    }
  }

  // 4) Sanity profit threshold
  const minProfitWei = BigInt(env.MIN_LIQUIDATION_PROFIT_USD) * 10n ** BigInt(position.baseTokenDecimals);
  if (best.profit < minProfitWei) {
    return {
      ok: false,
      reason: `profit ${formatWei(best.profit, position.baseTokenDecimals)} < threshold $${env.MIN_LIQUIDATION_PROFIT_USD}`,
    };
  }

  const decision: LiquidationDecision = {
    flashloanAmount: best.L,
    expectedProfitWei: best.profit,
    expectedProfitUsd: Number(best.profit) / 10 ** position.baseTokenDecimals,
    estimatedSlippageBps: best.slippageBps,
    minProfitWei: (best.profit * 7n) / 10n,
  };

  logger.info(
    {
      comet: position.cometName,
      borrower: position.borrower,
      baseAmountWei: best.L.toString(),
      profitUsd: decision.expectedProfitUsd.toFixed(2),
      slippageBps: best.slippageBps,
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

  // 4. Custos: flashloan fee + gas
  const flashloanFee = (baseAmount * AAVE_FLASHLOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
  const gasCostWei = BigInt(Math.floor(env.GAS_COST_USD_ESTIMATE)) *
    10n ** BigInt(position.baseTokenDecimals);

  // 5. Slippage check: comparar swapOutput vs amount esperado (ideal = collateral × oracle_price)
  // Pra MVP usamos baseAmount + bonus (~liquidationFactor) como proxy do "esperado sem slippage"
  const expectedNoSlippage = (baseAmount * BPS_DENOMINATOR + 100n) / BPS_DENOMINATOR;
  const slippageBps = expectedNoSlippage > bestQuote.amountOut
    ? Number(((expectedNoSlippage - bestQuote.amountOut) * BPS_DENOMINATOR) / expectedNoSlippage)
    : 0;
  if (slippageBps > env.MAX_SLIPPAGE_BPS) return null;

  const profit = bestQuote.amountOut > baseAmount + flashloanFee + gasCostWei
    ? bestQuote.amountOut - baseAmount - flashloanFee - gasCostWei
    : 0n;

  return { profit, slippageBps };
}

function formatWei(wei: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = wei / divisor;
  const fraction = wei % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, '0').slice(0, 4)}`;
}
