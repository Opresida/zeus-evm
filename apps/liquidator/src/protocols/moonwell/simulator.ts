/**
 * Moonwell — wrapper fino do simulator genérico (eth_call validation).
 */

import { simulateArbitrage, type SimulateParams, type SimulationResult } from '@zeus-evm/strategy';

export type MoonwellSimulationResult = SimulationResult;
export type SimulateMoonwellParams = SimulateParams;

export async function simulateMoonwellLiquidation(
  params: SimulateMoonwellParams,
): Promise<MoonwellSimulationResult> {
  return simulateArbitrage(params);
}
