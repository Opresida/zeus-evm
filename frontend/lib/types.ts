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
  swapVenue?: string;
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
  competitorAlias?: string;
  // Fase E (item 5) — vencedor da corrida mesmo sem alias resolvido.
  competitorSender?: string;
  winnerPriorityFeeGwei?: number;
  // Fase 2b — post-mortem (no payload do failure.recorded)
  winner_priority_fee_gwei?: number;
  our_tx_index?: number;
  is_bottom_10pct?: boolean;
  relative_position?: number;
  // Fase 2b — calibration.applied
  oldThresholdUsd?: number;
  newThresholdUsd?: number;
  topProtocol?: string | null;
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
  errorMetrics?: { failedOps: number; totalOps: number };
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
  /** Comparativo por estratégia (tela "Estratégias"). */
  strategy_stats:
    | { strategy: 'classic-liq' | 'pre-liq' | 'filler' | 'arb'; candidates24h: number; candidateProfitUsd24h: number; executed24h: number; netUsd24h: number }[]
    | null;
  /** Universo vetado por token (tela "Tokens") — porteiro de tokens. */
  vetted_universe:
    | { token: string; symbol: string; motor: 'motor1' | 'motor2'; verdict: 'pass' | 'reject'; reason: string; exitDex?: string; liquidityUsd: number; locked: boolean; lockPct?: number; locker?: string; unlockIso?: string; partial?: boolean }[]
    | null;
  /** Estado do filtro de tokens por motor (badge "filtro ligado"). */
  vetting_enforce: { motor1?: boolean; motor2?: boolean } | null;
  /** ISO do último re-vet do porteiro (freshness). */
  vetting_revet_at: string | null;
  /** Pulso do radar (item 2) — último tick de descoberta. */
  discovery: { positions: number; dispatched: number; rejected: number; atIso: string } | null;
  /** Agregados de inteligência (item 3) — market-bribe, competidores, drift. */
  intel: {
    marketBribeP50Gwei?: number;
    marketBribeP75Gwei?: number;
    marketBribeP95Gwei?: number;
    competitorsActive?: number;
    driftBps?: number;
    sustainedAlerts?: number;
    ourBribeGwei?: number;
    bribeAutoRaised?: boolean;
    bribeReason?: string;
    /** Motor 2: o ZEUS LIGOU sozinho a gorjeta competitiva (nível-feature). */
    competitiveBribeAutoEnabled?: boolean;
    bribeAutoEnableReason?: string;
  } | null;
  // ----- Fase 2 — blocos extras (jsonb) -----
  /** Prontidão dos componentes (tela Saúde). */
  health: { components: { name: string; ok: boolean; detail?: string }[] } | null;
  /** Top competidores observados (tela Inteligência). */
  competitors: { alias: string; category: string; txs: number; bribeGwei: number; threat: number }[] | null;
  /** Ranking de pares com edge persistente (Motor 2). */
  edge_pairs: { pair: string; score: number; persistPct: string; avgBps: number; samples: number }[] | null;
  /** Cooldowns / motivos de auto-pause ativos. */
  cooldowns: { label: string; reason: string; active: boolean }[] | null;
  /** Kill switch (perda 24h vs limite). */
  kill_switch: { loss24hUsd: number; limitUsd: number; triggered: boolean } | null;
  /** Fase 2b — latência de dispatch p50/p95 (ms). */
  latency: { p50Ms: number; p95Ms: number; samples: number } | null;
  /** Motor 1 — resiliência de reorg (reorgs na janela + órfãs recuperadas). */
  reorgs: { window24h: number; orphansRecovered: number; orphansDetected: number } | null;
  competition: Competition | null;
  error_metrics: { failedOps: number; totalOps: number } | null;
  updated_at: string;
}

/** Linha de `wallet_snapshots` (Fase 2b — snapshot diário de saldo p/ o gráfico 30d). */
export interface WalletSnapshotRow {
  id: number;
  service: string;
  chain: string | null;
  ts: string;
  balance_eth: number | null;
  balance_usd: number | null;
}

/** Agregado comparativo por estratégia (clássica × pré-liq × filler) — tela "Estratégias". */
export interface StrategyStat {
  strategy: "classic-liq" | "pre-liq" | "filler" | "arb";
  candidates24h: number;
  candidateProfitUsd24h: number;
  executed24h: number;
  netUsd24h: number;
}

/** Token vetado (porteiro) — linha achatada pro painel (tela "Tokens"). */
/** Diagnóstico de concorrência (item 4) — builders dominantes + nossa posição no bloco. */
export interface Competition {
  topBuilders: { alias: string; blocks: number; competitorTxs: number; ourTxs: number }[];
  position: { samples: number; bottom10pctPct: number; top10pctPct: number; avgRelative: number };
}

export interface VettedToken {
  token: string;
  symbol: string;
  motor: "motor1" | "motor2";
  verdict: "pass" | "reject";
  /** Motivo principal em PT-BR simples. */
  reason: string;
  /** DEX da saída (quando pass). */
  exitDex?: string;
  liquidityUsd: number;
  locked: boolean;
  /** Lock rico (Tier 0): % travado, locker, vencimento. */
  lockPct?: number;
  locker?: string;
  unlockIso?: string;
  /** Verdict feito com dados incompletos (fail-safe: M1 não bloqueia, M2 rejeita) → selo "dados parciais". */
  partial?: boolean;
}

/** Estado de UI controlado pelo painel. */
export interface UiState {
  screen: "home" | "tx" | "pnl" | "wallet" | "intel" | "health" | "strategies" | "tokens" | "reports" | "settings" | "admin";
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
  /** Modo real do bot (dryrun | testnet | mainnet) vindo do heartbeat. */
  mode?: string;
  /** Chain real do bot (ex.: "Base") vinda do heartbeat. */
  chain?: string;
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
  /** Falhas recentes (item 1) — de failure.recorded: categoria + quem nos ganhou. */
  failures?: { time: string; color: string; protocol: string; category: string; detail: string }[];
  /** Pulso do radar (item 2) — "scanner vivo · viu N posições · há Xs". */
  discovery?: { service: string; positions: number; dispatched: number; rejected: number; ago: string };
  /** Inteligência real (item 3) — market-bribe / competidores / drift (substitui mock quando presente). */
  intel?: { marketBribeP50Gwei?: number; marketBribeP75Gwei?: number; marketBribeP95Gwei?: number; competitorsActive?: number; driftBps?: number; sustainedAlerts?: number; ourBribeGwei?: number; bribeAutoRaised?: boolean; bribeReason?: string; competitiveBribeAutoEnabled?: boolean; bribeAutoEnableReason?: string };
  /** Mini-cards por motor (item 4) — PnL + ops por motor, derivado dos eventos tx.*. */
  motorCards?: { tag: string; label: string; netUsd: number; ops: number }[];
  /** Comparativo por estratégia (tela "Estratégias") — fundido dos heartbeats liquidator+mis-scanner. */
  strategyStats?: StrategyStat[];
  /** Universo vetado por token (tela "Tokens") — porteiro; fundido dos heartbeats por (token, motor). */
  vettedUniverse?: VettedToken[];
  /** Log de entrou/saiu (tela "Tokens") — dos eventos token.entered/token.exited. */
  tokenLog?: { time: string; symbol: string; motor: string; action: string; reason: string; color: string }[];
  /** Estado do filtro de tokens por motor (badge na tela "Tokens"). */
  vettingEnforce?: { motor1?: boolean; motor2?: boolean };
  /** ISO do último re-vet do porteiro (freshness "re-vet há Xs"). */
  vettingRevetAt?: string;

  // ----- Fase 1: agregados de PnL / gás / relatórios (derivados de events tx.*) -----
  kpi7d?: number;
  kpi30d?: number;
  kpiProj?: number;
  kpiW14sum?: number;
  raw14?: number[];
  pnlSeries?: Record<string, number[]>;
  expSeries?: Record<string, number[]>;
  motorBreak?: { name: string; val: number; pct: string }[];
  protoBreak?: { name: string; val: number; pct: string }[];
  gas24h?: number;
  gas24hEth?: string;
  gas30d?: number;
  gas30dPct?: string;
  repByPeriod?: Record<string, { net: number; win: string; ops: string; gas: number; drift: string; bestMotor: string; range: string; label: string }>;

  // ----- Fase 2 — blocos do heartbeat (service_status) -----
  /** Competidores reais. `wonVsUs` (Fase 2b) = corridas que ele nos ganhou (head-to-head). */
  competitors?: { alias: string; category: string; txs: number; bribeGwei: number; threat: number; wonVsUs?: number }[];
  /** Ranking de pares com edge persistente (Motor 2). */
  edgePairs?: { pair: string; score: number; persistPct: string; avgBps: number; samples: number }[];
  /** Prontidão dos componentes (tela Saúde). */
  health?: { name: string; ok: boolean; detail?: string }[];
  /** Cooldowns / auto-pause ativos. */
  cooldowns?: { label: string; reason: string; active: boolean }[];
  /** Kill switch (perda 24h vs limite). */
  killSwitch?: { loss24hUsd: number; limitUsd: number; triggered: boolean };

  // ----- Fase 2b -----
  /** Post-mortem (corridas perdidas) — derivado de failure.recorded com vencedor. */
  postmortem?: { time: string; text: string; pos: string }[];
  /** Log de auto-calibração — de calibration.applied. */
  calib?: { time: string; effect: string; text: string }[];
  /** Latência de dispatch p50/p95 (ms) — do service_status. */
  latency?: { p50Ms: number; p95Ms: number; samples: number };
  /** Resiliência de reorg (Motor 1) — reorgs 24h + órfãs recuperadas. */
  reorgs?: { window24h: number; orphansRecovered: number; orphansDetected: number };
  /** Diagnóstico de concorrência (item 4) — builders dominantes + nossa posição no bloco. */
  competition?: Competition;
  /** Taxa de erro real (KPI Saúde) — falhas vs total de ops. */
  errorMetrics?: { failedOps: number; totalOps: number };
  /** Uptime real (KPI Saúde) — segundos, do heartbeat mais fresco. */
  uptimeSec?: number;
  /** Histórico de saldo (USD) p/ o gráfico 30d — de wallet_snapshots. */
  whRaw?: number[];
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
  /** DEX da troca colateral→dívida (multi-DEX do Motor 1): uniswap-v3 | aerodrome | slipstream. */
  venue?: string;
}
