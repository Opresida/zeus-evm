/**
 * Morpho Blue — wrapper fino do simulator genérico (eth_call validation).
 */

import { simulateArbitrage, type SimulateParams, type SimulationResult } from '@zeus-evm/strategy';

export type MorphoSimulationResult = SimulationResult;
export type SimulateMorphoParams = SimulateParams;

export async function simulateMorphoLiquidation(
  params: SimulateMorphoParams,
): Promise<MorphoSimulationResult> {
  return simulateArbitrage(params);
}
