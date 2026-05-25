/**
 * Compound III — wrapper fino do simulator genérico.
 *
 * O `@zeus-evm/strategy.simulateArbitrage` é genérico (recebe calldata + caller).
 * Aqui só renomeamos com semântica de Compound liquidation.
 */

import { simulateArbitrage, type SimulateParams, type SimulationResult } from '@zeus-evm/strategy';

export type CompoundSimulationResult = SimulationResult;
export type SimulateCompoundParams = SimulateParams;

export async function simulateCompoundLiquidation(
  params: SimulateCompoundParams,
): Promise<CompoundSimulationResult> {
  return simulateArbitrage(params);
}
