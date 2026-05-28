/**
 * Moonwell — calculator de liquidation + profit.
 *
 * Compound V2 não tem swap inline nativo — o bônus vem do liquidationIncentive
 * (ex: 1.08 = 8%). Estratégia:
 *   - repayAmount = closeFactor × borrowBalance (cap on-chain via maxTrade)
 *   - colateral seizado vale ≈ repayAmount × incentive (em USD)
 *   - swap colateral → borrowed: output esperado ≈ repayAmount × incentive − slippage
 *   - profit ≈ repayAmount × (incentive − 1) − premium − gas
 *
 * ⚠️ APROXIMAÇÃO: sem oracle price off-chain, estimamos o seized via incentive.
 * O contrato ZeusMoonwellLiquidator enforça minProfitWei REAL on-chain — se a
 * estimativa errar, a tx reverte (não perde dinheiro). Guarda definitiva é o contrato.
 */

import type { LiquidatorEnv } from '../../config';
import type { MoonwellLiquidatablePosition, LiquidationDecision } from '../../types';
import { estimateUsd } from '@zeus-evm/execution-utils';

const WAD = 10n ** 18n;
const AAVE_FLASHLOAN_PREMIUM_BPS = 5n; // 0.05%
const BPS_DENOMINATOR = 10_000n;

export interface MoonwellCalculatorOpts {
  env: LiquidatorEnv;
  /** Cap em wei do borrowedUnderlying (maxTrade do contrato). */
  capWei?: bigint;
}

export interface MoonwellLiquidationOutcome {
  ok: boolean;
  reason?: string;
  decision?: LiquidationDecision;
  /** Valor esperado de saída do swap (borrowed wei) — pra builder aplicar slippage. */
  expectedSwapOutputWei?: bigint;
}

export function calculateOptimalMoonwellLiquidation(
  position: MoonwellLiquidatablePosition,
  opts: MoonwellCalculatorOpts,
): MoonwellLiquidationOutcome {
  const { env } = opts;

  if (position.borrowBalanceWei === 0n) {
    return { ok: false, reason: 'borrowBalance zero' };
  }
  if (position.liquidationIncentiveMantissa <= WAD) {
    return { ok: false, reason: 'liquidationIncentive <= 1 (sem bônus)' };
  }

  // repayAmount = closeFactor × borrowBalance
  let repayAmount = (position.borrowBalanceWei * position.closeFactorMantissa) / WAD;
  // Respeita cap on-chain (se configurado)
  if (opts.capWei && opts.capWei > 0n && repayAmount > opts.capWei) {
    repayAmount = opts.capWei;
  }
  if (repayAmount === 0n) {
    return { ok: false, reason: 'repayAmount calculado como 0' };
  }

  // Colateral seizado vale ≈ repayAmount × incentive (em borrowed token terms).
  // Após swap collateral→borrowed, esperamos receber ≈ esse valor (− slippage).
  const expectedSwapOutput = (repayAmount * position.liquidationIncentiveMantissa) / WAD;

  // Profit bruto ≈ swapOutput − repay − premium
  const flashloanFee = (repayAmount * AAVE_FLASHLOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
  const grossProfitWei = expectedSwapOutput > repayAmount + flashloanFee
    ? expectedSwapOutput - repayAmount - flashloanFee
    : 0n;

  if (grossProfitWei === 0n) {
    return { ok: false, reason: 'profit bruto estimado = 0 (incentive não cobre premium)' };
  }

  // Profit USD via estimateUsd (borrowed: stable=peg, WETH=×ethPrice)
  const profitUsd = estimateUsd(
    position.borrowedSymbol,
    grossProfitWei,
    position.borrowedDecimals,
    env.ETH_USD_PRICE_ESTIMATE,
  ) ?? 0;

  const netProfitUsd = profitUsd - env.GAS_COST_USD_ESTIMATE;
  if (netProfitUsd < env.MIN_LIQUIDATION_PROFIT_USD) {
    return { ok: false, reason: `profit líquido $${netProfitUsd.toFixed(2)} < threshold $${env.MIN_LIQUIDATION_PROFIT_USD}` };
  }

  const decision: LiquidationDecision = {
    flashloanAmount: repayAmount,
    expectedProfitWei: grossProfitWei,
    expectedProfitUsd: netProfitUsd,
    estimatedSlippageBps: 0, // estimado pós-swap; guarda real é minProfitWei on-chain
    // minProfit floor conservador: 50% do estimado (Compound V2 swap pode ter slippage maior)
    minProfitWei: (grossProfitWei * 5n) / 10n,
  };

  return { ok: true, decision, expectedSwapOutputWei: expectedSwapOutput };
}
