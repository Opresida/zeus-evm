// ===== Contrato de eventos do ZEUS =====
// Espelha os eventos emitidos por packages/execution-utils/src/events.ts
// e enviados pelo genericWebhookSink (POST JSON) para /api/ingest.

export type Severity = "info" | "warn" | "critical";
export type Mode = "dryrun" | "testnet" | "mainnet";

export type ZeusEventType =
  | "tx.confirmed"
  | "tx.reverted_on_chain"
  | "tx.reverted_pre_dispatch"
  | "pnl.reconciled"
  | "failure.recorded"
  | "gas.alert"
  | "gas.recovered"
  | "pnl.kill_switch_triggered"
  | "failure.cooldown_activated"
  | "failure.cooldown_expired"
  | "backrun.opportunity_found"
  | "backrun.dispatched"
  | "backrun.rejected"
  | "whale.swap_detected"
  | "discovery.tick_completed"
  | "liquidator.boot"
  | "liquidator.shutdown"
  | "zeus.heartbeat";

/** Evento bruto recebido no webhook. Campos variam por `type`. */
export interface ZeusEvent {
  type: ZeusEventType | string;
  severity?: Severity;
  timestamp?: string; // ISO
  chain?: string;
  mode?: Mode | string;
  // tx.*
  txHash?: string;
  protocol?: string;
  borrower?: string;
  pair?: string;
  profitUsd?: number;
  gasCostUsd?: number;
  netProfitUsd?: number;
  profitDeltaBps?: number;
  blockNumber?: number;
  reason?: string;
  // pnl.reconciled
  expectedNetUsd?: number;
  realizedNetUsd?: number;
  gasUsd?: number;
  attributionCause?: string;
  // failure.recorded
  failureCategory?: string;
  gasUsdLost?: number;
  // gas.*
  account?: string;
  balanceEth?: number;
  balanceUsd?: number;
  status?: string;
  // kill switch
  loss24hUsd?: number;
  limitUsd?: number;
  // cooldown
  consecutiveFailures?: number;
  cooldownSec?: number;
  lastFailureReason?: string;
  // heartbeat
  gasReserveEth?: number;
  gasReserveUsd?: number;
  uptimeSec?: number;
  service?: string;
  adaptiveMinEvUsd?: number;
  autoPaused?: boolean;
  motorStats?: { tag: string; ops: number; netPnl24hUsd: number }[];
  // catch-all
  [k: string]: unknown;
}

/** Linha persistida na tabela `events` do Supabase. */
export interface EventRow {
  id: number;
  type: string;
  severity: Severity | null;
  ts: string;
  chain: string | null;
  mode: string | null;
  protocol: string | null;
  pair: string | null;
  tx_hash: string | null;
  borrower: string | null;
  profit_usd: number | null;
  gas_usd: number | null;
  net_profit_usd: number | null;
  profit_delta_bps: number | null;
  block_number: number | null;
  payload: ZeusEvent;
}

/** Linha de `service_status` (heartbeat por serviço — upsert). */
export interface ServiceStatusRow {
  service: string;
  chain: string | null;
  mode: string | null;
  uptime_sec: number | null;
  gas_reserve_eth: number | null;
  gas_reserve_usd: number | null;
  adaptive_min_ev_usd: number | null;
  auto_paused: boolean | null;
  motor_stats: { tag: string; ops: number; netPnl24hUsd: number }[] | null;
  updated_at: string;
}

/** Estado de UI controlado pelo painel. */
export interface UiState {
  screen: "home" | "tx" | "pnl" | "wallet" | "intel" | "health" | "reports" | "settings";
  theme: "navy" | "black";
  txFilter: "all" | "ok" | "rev" | "pre";
  period: "daily" | "weekly" | "monthly";
  query: string;
  tick: number;
  notif: Record<string, boolean>;
  chans: Record<string, boolean>;
}

/**
 * Overrides "ao vivo" derivados dos eventos reais do Supabase. Quando ausente,
 * o view-model usa os dados representativos do design (lib/mockData).
 */
export interface LiveSnapshot {
  botStatus?: string;
  gasEth?: string;
  gasUsd?: string;
  runwayDays?: string;
  adaptiveEv?: string;
  kpiToday?: number;
  kpiTodayTx?: number;
  kpiOk?: number;
  kpiFail?: number;
  kpiWinRate?: string;
  ticker?: { color: string; text: string; time: string }[];
  txRows?: TxRow[];
  txCounts?: { all: number; ok: number; rev: number; pre: number };
  eventLog?: { time: string; color: string; type: string; text: string }[];
  /** Drift sustentado real (de pnl.reconciled) — alimenta a tela Inteligência. */
  driftAlarms?: { color: string; text: string; bps: string }[];
}

export interface TxRow {
  st: "ok" | "rev" | "pre";
  protocol: string;
  pair: string;
  net: number;
  gas: number;
  drift: number;
  hash: string | null;
  mode: string;
  time: string;
  reason?: string;
}
