/**
 * Morpho PRE-liquidation — wrapper fino do simulator genérico (eth_call validation).
 *
 * Antes de assinar/disparar, faz eth_call do executePreMorphoLiquidation pra provar que o
 * round-trip (preLiquidate → onPreLiquidate → swap → repay) não reverte e que o lucro real
 * (medido pelo minProfitWei on-chain) bate. Falha = não dispara (só gás zero).
 */

import { simulateArbitrage, type SimulateParams, type SimulationResult } from '@zeus-evm/strategy';

export type PreLiquidationSimulationResult = SimulationResult;
export type SimulatePreLiquidationParams = SimulateParams;

export async function simulatePreLiquidation(
  params: SimulatePreLiquidationParams,
): Promise<PreLiquidationSimulationResult> {
  return simulateArbitrage(params);
}
