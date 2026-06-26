/**
 * Tipos compartilhados entre apps (detector, monitor) e camada off-chain.
 * Espelham structs do contrato Solidity (ZeusExecutor.sol).
 */

import type { Address, Hex } from 'viem';

// ─── Mirror dos structs Solidity ───

/**
 * Tipos de DEX suportados. FONTE ÚNICA do enum no TS — `@zeus-evm/dex-adapters` re-exporta daqui.
 * Espelhado em `contracts/src/interfaces/IZeusExecutor.sol` (enum Solidity): os valores DEVEM bater
 * com o `uint8 dexType` on-chain. SÓ APPEND, NUNCA REORDENAR (quebra a calldata já encodada).
 * Guarda automática: `packages/dex-adapters/src/dexType.pin.test.ts`.
 */
export enum DexType {
  UniswapV2 = 0,
  UniswapV3 = 1,
  Aerodrome = 2,
  Curve = 3,
  Balancer = 4,
  Slipstream = 5, // Aerodrome Slipstream CL — SlipstreamLib
  PancakeV3 = 6, // Pancake V3 (struct exactInputSingle COM deadline) — PancakeV3Lib
  UniswapV4 = 7, // Uniswap V4 (singleton PoolManager) via Universal Router — UniswapV4Lib
}

/**
 * Fonte do flashloan que financia uma operação (deve bater com `enum FlashSource` no Solidity).
 * Prioridade econômica: Morpho/Balancer (0%) antes de Aave (0,05%). Aave = 0 (default legado).
 */
export enum FlashSource {
  Aave = 0,     // 0,05% premium, fallback universal
  Morpho = 1,   // 0% — Morpho Blue singleton
  Balancer = 2, // 0% — Balancer V2 Vault
}

/** Fee em basis points por fonte de flashloan (Aave 0,05% = 5 bps; Morpho/Balancer 0%). */
export const FLASH_SOURCE_PREMIUM_BPS: Record<FlashSource, bigint> = {
  [FlashSource.Aave]: 5n,
  [FlashSource.Morpho]: 0n,
  [FlashSource.Balancer]: 0n,
};

/** Espelha `struct SwapStep` no ZeusExecutor.sol */
export interface SwapStep {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint; // 0 = usar saldo atual (chain de swaps)
  minAmountOut: bigint;
  dexType: DexType;
  extraData: Hex; // fee tier (UniV3), pool address (Curve), etc.
}

/** Espelha `struct ArbitrageParams` no ZeusExecutor.sol */
export interface ArbitrageParams {
  steps: SwapStep[];
  minProfitWei: bigint;
  profitToken: Address;
  profitReceiver: Address;
  flashSource: FlashSource;
}

// ─── Tipos da camada off-chain (não vão pro contrato) ───

export type OpportunityType =
  | 'cross-dex'    // arbitragem entre 2 DEXs
  | 'triangular'   // ciclo no mesmo DEX
  | 'liquidation'; // liquidação de posição

export interface Opportunity {
  id: string;
  type: OpportunityType;
  detectedAt: number; // unix timestamp ms
  blockNumber: bigint;

  // Tokens envolvidos
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;

  // Profit estimado
  expectedProfitWei: bigint;
  expectedProfitUsd: number;

  // Custos estimados
  estimatedGasCost: bigint;
  flashloanFeeBps: number; // 0 = capital próprio

  // Steps montados
  steps: SwapStep[];

  // Origem
  triggeredByTx?: Hex; // se origem é mempool watching
}

export interface Pool {
  address: Address;
  dexType: DexType;
  token0: Address;
  token1: Address;
  fee?: number;        // bps — só UniV3
  reserves0?: bigint;  // UniV2 / Aerodrome
  reserves1?: bigint;
  tick?: number;       // UniV3
  liquidity?: bigint;  // UniV3
}

/** Resultado da execução de uma oportunidade */
export interface ExecutionResult {
  opportunityId: string;
  txHash: Hex;
  status: 'success' | 'reverted' | 'pending';
  actualProfitWei: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
  blockNumber: bigint;
  landedAt: number; // unix timestamp ms
  landedTimeMs: number; // detected → landed
}
