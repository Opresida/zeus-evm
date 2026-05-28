/**
 * Eventos canônicos do ZEUS — fonte única de verdade pra:
 *   - Webhook outbound (Discord/Telegram durante observação)
 *   - WebSocket pro mobile app futuro
 *   - Log estruturado pra dashboards
 *   - Anomaly detection futuro
 *
 * Discriminated union por `type` permite handlers/sinks tipados sem `any`.
 *
 * Severidades:
 *   - 'info': operação normal (boot, tick, win)
 *   - 'warn': atenção mas não emergência (cooldown, gas baixo, position stale)
 *   - 'critical': emergência (kill switch, gas crítico, dispatch falhou várias)
 */

import type { Address } from 'viem';

export type Severity = 'info' | 'warn' | 'critical';

export type ZeusEvent =
  | LiquidatorBootEvent
  | LiquidatorShutdownEvent
  | TxConfirmedEvent
  | TxRevertedOnChainEvent
  | TxRevertedPreDispatchEvent
  | PnlKillSwitchTriggeredEvent
  | FailureCooldownActivatedEvent
  | FailureCooldownExpiredEvent
  | GasReserveAlertEvent
  | GasReserveRecoveredEvent
  | DiscoveryTickCompletedEvent
  | WhaleSwapDetectedEvent
  | BackrunOpportunityFoundEvent
  | BackrunDispatchedEvent
  | BackrunRejectedEvent;

interface BaseEvent {
  /** ISO timestamp da emissão */
  timestamp: string;
  /** Identificador da chain ativa (ex: "Base", "Arbitrum") */
  chain: string;
  /** Modo de operação no momento ('dryrun' | 'testnet' | 'mainnet') */
  mode: 'dryrun' | 'testnet' | 'mainnet';
  severity: Severity;
}

export interface LiquidatorBootEvent extends BaseEvent {
  type: 'liquidator.boot';
  severity: 'info';
  executorAddress: Address | null;
  account: Address | null;
}

export interface LiquidatorShutdownEvent extends BaseEvent {
  type: 'liquidator.shutdown';
  severity: 'info';
  uptimeSec: number;
  reason: string;
}

export interface TxConfirmedEvent extends BaseEvent {
  type: 'tx.confirmed';
  severity: 'info';
  txHash: `0x${string}`;
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell';
  borrower: Address;
  profitUsd: number | null;
  gasCostUsd: number;
  netProfitUsd: number | null;
  profitDeltaBps: number;
  blockNumber: string;
}

export interface TxRevertedOnChainEvent extends BaseEvent {
  type: 'tx.reverted_on_chain';
  severity: 'warn';
  txHash: `0x${string}`;
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell';
  borrower: Address;
  gasUsdLost: number;
  blockNumber: string;
}

export interface TxRevertedPreDispatchEvent extends BaseEvent {
  type: 'tx.reverted_pre_dispatch';
  severity: 'info'; // não custou gas — é proteção funcionando
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell';
  borrower: Address;
  reason: string;
}

export interface PnlKillSwitchTriggeredEvent extends BaseEvent {
  type: 'pnl.kill_switch_triggered';
  severity: 'critical';
  loss24hUsd: number;
  limitUsd: number;
  onChainKillResult?: 'submitted' | 'already_killed' | 'dryrun_skipped' | 'no_wallet' | 'failed';
}

export interface FailureCooldownActivatedEvent extends BaseEvent {
  type: 'failure.cooldown_activated';
  severity: 'warn';
  consecutiveFailures: number;
  cooldownSec: number;
  lastFailureReason: string;
}

export interface FailureCooldownExpiredEvent extends BaseEvent {
  type: 'failure.cooldown_expired';
  severity: 'info';
}

export interface GasReserveAlertEvent extends BaseEvent {
  type: 'gas.alert';
  severity: 'warn' | 'critical';
  account: Address;
  balanceEth: string;
  balanceUsd: number;
  status: 'warn' | 'critical';
}

export interface GasReserveRecoveredEvent extends BaseEvent {
  type: 'gas.recovered';
  severity: 'info';
  account: Address;
  balanceEth: string;
  balanceUsd: number;
  previousStatus: 'warn' | 'critical';
}

export interface DiscoveryTickCompletedEvent extends BaseEvent {
  type: 'discovery.tick_completed';
  severity: 'info';
  aavePositions: number;
  compoundPositions: number;
  dispatched: number;
  dryrun: number;
  rejected: number;
  elapsedMs: number;
}

// ─── Backrun engine events ──────────────────────────────────────────────
// O backrun-engine consome WhaleSwapDetectedEvent (emitido pelo detector
// quando vê um swap whale na mempool) e emite os outros 3 conforme o
// pipeline avança (oportunidade encontrada → dispatch / rejection).

/** DEX onde o swap whale foi observado. */
export type WhaleSwapVenue = 'uniswap-v3' | 'aerodrome' | 'unknown';

export interface WhaleSwapDetectedEvent extends BaseEvent {
  type: 'whale.swap_detected';
  severity: 'info';
  /** Tx hash da pending tx do whale (mempool). */
  pendingTxHash: `0x${string}`;
  /** DEX/venue do swap. */
  venue: WhaleSwapVenue;
  /** Token de entrada do swap whale (vendido). */
  tokenIn: Address;
  /** Token de saída do swap whale (comprado). */
  tokenOut: Address;
  /** Quantidade de entrada (em wei do tokenIn). */
  amountIn: string;
  /** Estimativa em USD do tamanho do swap (pra threshold "whale"). */
  amountInUsd: number;
  /** Router/pool address envolvido. */
  router: Address;
  /** Sender do swap (origin) — quando disponível na pending tx. */
  sender: Address | null;
}

export interface BackrunOpportunityFoundEvent extends BaseEvent {
  type: 'backrun.opportunity_found';
  severity: 'info';
  pendingTxHash: `0x${string}`;
  pairId: string;
  buyVenue: string;
  sellVenue: string;
  expectedProfitUsd: number;
  estimatedSlippageBps: number;
}

export interface BackrunDispatchedEvent extends BaseEvent {
  type: 'backrun.dispatched';
  severity: 'info';
  pendingTxHash: `0x${string}`;
  pairId: string;
  flashloanAmountWei: string;
  expectedProfitUsd: number;
  /** Tx hash do nosso backrun (não da whale tx). Null em dryrun. */
  ourTxHash: `0x${string}` | null;
}

export interface BackrunRejectedEvent extends BaseEvent {
  type: 'backrun.rejected';
  severity: 'info';
  pendingTxHash: `0x${string}`;
  reason: string;
  stage: 'decode' | 'plan' | 'simulate' | 'profit_below_threshold' | 'gas_too_high' | 'other';
}
