/**
 * Filtros de oportunidade — eliminam oportunidades que não valem submeter.
 *
 * Critérios:
 *   - Profit USD > MIN_PROFIT_USD (deve cobrir gas + flashloan fee + buffer)
 *   - Profit em bps > slippage tolerada (senão risco de revert por slippage)
 *   - Amount in <= MAX_TRADE_ETH (circuit breaker)
 */

import type { CrossDexOpportunity } from './crossDex';

export interface FilterCriteria {
  minProfitUsd: number;
  /** Slippage tolerada em basis points (50 = 0.5%) */
  maxSlippageBps: number;
  /** Cap absoluto em wei do tokenA */
  maxTradeWei: bigint;
  /** Custo estimado de gas em USD (subtrair do profit) */
  estimatedGasUsd: number;
  /** Fee do flashloan em bps (5 = 0.05% Aave V3). 0 se modalidade wallet-only */
  flashloanFeeBps: number;
}

export interface FilterResult {
  passed: boolean;
  reason?: string;
  /** Profit líquido em USD após gas + flashloan fee */
  netProfitUsd?: number;
}

export function filterOpportunity(
  opp: CrossDexOpportunity,
  criteria: FilterCriteria,
): FilterResult {
  // 1) Cap absoluto
  if (opp.amountIn > criteria.maxTradeWei) {
    return { passed: false, reason: `amountIn ${opp.amountIn} > maxTradeWei ${criteria.maxTradeWei}` };
  }

  // 2) Calcular custos
  const flashloanCostUsd =
    criteria.flashloanFeeBps > 0
      ? (opp.profitUsd * criteria.flashloanFeeBps) / 10_000
      : 0;
  const netProfitUsd = opp.profitUsd - criteria.estimatedGasUsd - flashloanCostUsd;

  // 3) Min profit
  if (netProfitUsd < criteria.minProfitUsd) {
    return {
      passed: false,
      reason: `net profit $${netProfitUsd.toFixed(2)} < min $${criteria.minProfitUsd}`,
      netProfitUsd,
    };
  }

  // 4) Margin sobre slippage — profit deve exceder slippage tolerada
  // Porque slippage extra pode comer todo o profit
  if (opp.profitBps < criteria.maxSlippageBps) {
    return {
      passed: false,
      reason: `profit ${opp.profitBps}bps <= slippage tolerado ${criteria.maxSlippageBps}bps`,
      netProfitUsd,
    };
  }

  return { passed: true, netProfitUsd };
}
