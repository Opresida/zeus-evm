/**
 * Tipos compartilhados do liquidator pipeline.
 * `AaveLiquidatablePosition` agora vem do package shared `@zeus-evm/aave-discovery`.
 */

// Re-export pra preservar imports relativos `from './types'`
export type { AaveLiquidatablePosition } from '@zeus-evm/aave-discovery';

import type { Address } from 'viem';

/** Position liquidável detectada em Compound III (Comet). */
export interface CompoundLiquidatablePosition {
  /** Endereço do Comet (cUSDCv3, cWETHv3) */
  comet: Address;
  /** Nome legível ("cUSDCv3") */
  cometName: string;
  borrower: Address;
  /** Base token do Comet (USDC, WETH) */
  baseToken: Address;
  baseTokenSymbol: string;
  baseTokenDecimals: number;
  /** Collateral dominante do borrower */
  collateralAsset: Address;
  collateralAssetSymbol: string;
  collateralAssetDecimals: number;
  /** Balance do collateral em wei */
  collateralBalanceWei: bigint;
  /** liquidationFactor do collateral (1e18 scale) */
  liquidationFactor: bigint;
}

/** Decisão calculada pelo calculator pra uma oportunidade. */
export interface LiquidationDecision {
  /** Valor exato do flashloan a pegar (wei do debtAsset). */
  flashloanAmount: bigint;
  /** Profit estimado em wei do debtAsset (após repay + gas + slippage). */
  expectedProfitWei: bigint;
  /** Profit estimado em USD (aproximação stable-peg, refinar via oracle em prod). */
  expectedProfitUsd: number;
  /** Slippage estimado em bps do swap final. */
  estimatedSlippageBps: number;
  /** Min profit threshold em wei (pra encodar no params). */
  minProfitWei: bigint;
  /** Razão se decision = null (descarte). */
  rejectReason?: string;
}

/** Tipo discriminado pra forçar handling de descarte. */
export type LiquidationOutcome =
  | { ok: true; decision: LiquidationDecision }
  | { ok: false; reason: string };

/** Resultado de simulação eth_call. */
export interface SimulationResult {
  /** True se eth_call retornou sucesso. */
  success: boolean;
  /** Gas usado estimado. */
  gasEstimate?: bigint;
  /** Razão do revert (decodificada se possível). */
  revertReason?: string;
}

/** Status final do dispatch. */
export type DispatchOutcome =
  | { status: 'dryrun_skipped'; reason: string }
  | { status: 'submitted'; txHash: `0x${string}` }
  | { status: 'reverted_pre_dispatch'; reason: string }
  | { status: 'reverted_on_chain'; txHash: `0x${string}`; reason: string }
  | {
      status: 'confirmed';
      txHash: `0x${string}`;
      /** Profit REAL extraído do event LiquidationExecuted (ou similar). */
      profitWei: bigint;
      /** Profit ESTIMADO pelo calculator pré-tx (pra comparativo). */
      expectedProfitWei: bigint;
      /** Diff em bps: positivo = real > expected; negativo = slippage > estimado. */
      profitDeltaBps: number;
      /** Gas usado on-chain (pra refinar GAS_COST_USD_ESTIMATE). */
      gasUsed: bigint;
      /** Bloco da inclusão. */
      blockNumber: bigint;
      /** Nome do evento (qual protocolo) — útil quando expandirmos pra multi-protocol. */
      eventName?: string;
      /** Profit em unidade humana (ex: "12.45" pra 12450000 wei de USDC) */
      profitFormatted?: string;
      /** Profit em USD (estimado via stable peg ou ETH price hardcoded) */
      profitUsd?: number;
      /** Custo de gas em USD */
      gasCostUsd?: number;
      /** Profit líquido após gas (USD) */
      netProfitUsd?: number;
      /** Symbol do asset em que o profit foi pago (ex: "USDC") */
      profitAssetSymbol?: string;
    };
