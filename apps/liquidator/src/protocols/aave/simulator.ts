/**
 * Aave V3 — wrapper fino sobre o simulator genérico.
 *
 * O `@zeus-evm/strategy.simulateArbitrage` já é genérico (recebe calldata + caller, faz eth_call).
 * Aqui só renomeamos com semântica de liquidation pra deixar o pipeline legível.
 */

import { simulateArbitrage, type SimulateParams, type SimulationResult } from '@zeus-evm/strategy';

export type LiquidationSimulationResult = SimulationResult;
export type SimulateLiquidationParams = SimulateParams;

/**
 * Simula executeLiquidation via eth_call (sem gastar gas).
 * Retorna sucesso/falha + decoded revert reason em caso de erro.
 */
export async function simulateLiquidation(
  params: SimulateLiquidationParams,
): Promise<LiquidationSimulationResult> {
  return simulateArbitrage(params);
}
