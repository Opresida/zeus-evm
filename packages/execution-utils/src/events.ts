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
  | BackrunRejectedEvent
  | PnlReconciledEvent
  | FailureRecordedEvent
  | ZeusHeartbeatEvent;

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
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'arb';
  borrower: Address;
  /** Par negociado — preenchido pelo Motor 2 (arb). Liquidações usam `borrower`. */
  pair?: string;
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
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'arb';
  borrower: Address;
  /** Par negociado — preenchido pelo Motor 2 (arb). */
  pair?: string;
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
  /** OIE — score composto [0,1] da oportunidade (opcional). */
  opportunityScore?: number;
  /** OIE — valor esperado ajustado a risco (EV), USD (opcional). */
  riskAdjustedEvUsd?: number;
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

// ─── Reconciliação de PnL (Fase 3) ──────────────────────────────────────
// Emitido após cada tx confirmada com reconciliação (esperado vs realizado).
// O EventIngester mapeia pra categoria 'pnl_reconciled' no ledger central.

export interface PnlReconciledEvent extends BaseEvent {
  type: 'pnl.reconciled';
  severity: 'info';
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'backrun' | 'arb';
  txHash: `0x${string}`;
  blockNumber: string;
  /** Net USD esperado pelo calculator (profit - gas). */
  expectedNetUsd: number;
  /** Net USD realizado (profit - gas - bribe). */
  realizedNetUsd: number;
  /** Drift do profit em bps (realizado vs esperado). */
  profitDeltaBps: number;
  /** Gás USD efetivamente pago. */
  gasUsd: number;
  /** Causa primária da diferença (do attributionAnalyzer). */
  attributionCause: string;
}

// ─── Falha categorizada (Fase 4) ────────────────────────────────────────
// Emitido junto com o failureCollector.record() pra levar a falha pro ledger central
// + alimentar o counter zeus_failures_total. Mapeado pra categoria 'failure_recorded'.

export interface FailureRecordedEvent extends BaseEvent {
  type: 'failure.recorded';
  severity: 'warn' | 'info';
  protocol: string;
  /** Categoria da falha (FailureCategory: lost_race, reverted_on_chain, ...). */
  failureCategory: string;
  txHash?: `0x${string}`;
  /** Gás USD perdido (quando a falha custou gas — revert on-chain). */
  gasUsdLost?: number;
  reason?: string;
  /** Post-mortem (Fase 5b): alias do competidor que nos ganhou, quando resolvido. */
  competitorAlias?: string;
}

// ─── Heartbeat (estado ao vivo) ─────────────────────────────────────────
// Os outros eventos são DELTAS (disparam num limiar). Pra gauges contínuos do painel
// (gás-agora, uptime, EV adaptativo, estado REAL do toggle) precisa de um snapshot periódico.
// Emitido a cada ~30s reusando valores já coletados no loop de métricas. No /api/ingest do
// painel, NÃO entra na tabela `events` (inundaria) — vira UPSERT em `service_status` (1 linha/serviço).

/** Stats resumidas por motor (pro mini-card do painel). */
export interface MotorStat {
  /** Identificador do motor ('motor1' | 'motor2' | 'motor3' ou nome do serviço). */
  tag: string;
  ops: number;
  netPnl24hUsd: number;
}

/**
 * Pulso do "radar" de descoberta (último tick de varredura). Vai no heartbeat (não como evento
 * próprio) pra não inundar a tabela `events` — `discovery.tick_completed` dispara a cada varredura.
 * Deixa o painel mostrar "scanner vivo · viu N posições · há Xs".
 */
export interface HeartbeatDiscovery {
  /** Total de posições liquidáveis vistas no último tick (soma dos protocolos). */
  positions: number;
  /** Quantas foram despachadas (ou simuladas em dryrun) no último tick. */
  dispatched: number;
  /** Quantas foram rejeitadas pelos gates no último tick. */
  rejected: number;
  /** ISO do último tick de descoberta. */
  atIso: string;
}

/**
 * Agregados de inteligência que o bot JÁ computa no loop de métricas (market-bribe, competidores,
 * calibração) — anexados ao heartbeat pra o painel mostrar os valores REAIS em vez de mock.
 * Esses dados vivem no DuckDB/Prometheus local do bot; o heartbeat é a ponte pro Vercel.
 */
export interface HeartbeatIntel {
  /** Lance de mercado mediano dos competidores (priority fee gwei). */
  marketBribeP50Gwei?: number;
  /** Lance de mercado agressivo (p95) — quanto custa ganhar a corrida. */
  marketBribeP95Gwei?: number;
  /** Competidores ativos na janela. */
  competitorsActive?: number;
  /** Drift médio realizado-vs-esperado (bps) — calibração. */
  driftBps?: number;
  /** Alertas de drift sustentado acumulados ("o bot está mentindo pra si mesmo"). */
  sustainedAlerts?: number;
}

export interface ZeusHeartbeatEvent extends BaseEvent {
  type: 'zeus.heartbeat';
  severity: 'info';
  /** Nome do serviço que emitiu (liquidator | backrun-engine | mis-scanner). */
  service: string;
  uptimeSec: number;
  /** Reserva de gás da wallet ativa. */
  gasReserveEth?: number;
  gasReserveUsd?: number;
  /** Threshold de EV adaptativo atual (USD), quando aplicável. */
  adaptiveMinEvUsd?: number;
  /** Estado REAL de execução: true = pausado/travado (no Motor 2 = toggle OFF). */
  autoPaused: boolean;
  motorStats?: MotorStat[];
  /** Pulso do radar de descoberta (item 2) — opcional (só motores com discovery). */
  discovery?: HeartbeatDiscovery;
  /** Agregados de inteligência (item 3) — opcional (reusa o que o loop de métricas já calcula). */
  intel?: HeartbeatIntel;
}
