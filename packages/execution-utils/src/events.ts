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
import type { VettedEntry } from './vetting/universeTracker';

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
  | CalibrationAppliedEvent
  | WalletSnapshotEvent
  | TokenEnteredEvent
  | TokenExitedEvent
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

/** Porteiro de tokens — um token ENTROU no universo de trading (passou no vetting). */
export interface TokenEnteredEvent extends BaseEvent {
  type: 'token.entered';
  severity: 'info';
  token: Address;
  symbol: string;
  motor: 'motor1' | 'motor2';
  /** = symbol (pro frontend toRow.pair). */
  pair: string;
  /** Motivo em PT-BR simples. */
  reason: string;
  exitDex?: string;
  liquidityUsd: number;
  locked: boolean;
  /** Etapa 2: false (só observa). Vira true quando o enforce está ligado (Etapa 3+). */
  wouldEnforce: boolean;
}

/** Porteiro de tokens — um token SAIU do universo (reprovou no vetting). */
export interface TokenExitedEvent extends BaseEvent {
  type: 'token.exited';
  severity: 'info';
  token: Address;
  symbol: string;
  motor: 'motor1' | 'motor2';
  pair: string;
  reason: string;
  exitDex?: string;
  liquidityUsd: number;
  locked: boolean;
  wouldEnforce: boolean;
}

export interface TxConfirmedEvent extends BaseEvent {
  type: 'tx.confirmed';
  severity: 'info';
  txHash: `0x${string}`;
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'morpho-preliq' | 'arb';
  borrower: Address;
  /** Par negociado — preenchido pelo Motor 2 (arb). Liquidações usam `borrower`. */
  pair?: string;
  profitUsd: number | null;
  gasCostUsd: number;
  netProfitUsd: number | null;
  profitDeltaBps: number;
  blockNumber: string;
  /** DEX usada na troca colateral→dívida (multi-DEX do Motor 1): 'uniswap-v3' | 'aerodrome' | 'slipstream'. */
  swapVenue?: string;
}

export interface TxRevertedOnChainEvent extends BaseEvent {
  type: 'tx.reverted_on_chain';
  severity: 'warn';
  txHash: `0x${string}`;
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'morpho-preliq' | 'arb';
  borrower: Address;
  /** Par negociado — preenchido pelo Motor 2 (arb). */
  pair?: string;
  gasUsdLost: number;
  blockNumber: string;
}

export interface TxRevertedPreDispatchEvent extends BaseEvent {
  type: 'tx.reverted_pre_dispatch';
  severity: 'info'; // não custou gas — é proteção funcionando
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'morpho-preliq';
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
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'morpho-preliq' | 'backrun' | 'arb';
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
  /** Endereço do vencedor (sempre presente quando houve corrida perdida, mesmo sem alias resolvido). */
  competitorSender?: string;
  /** Gorjeta (priority fee, gwei) do vencedor — "perdemos por X gwei". */
  winnerPriorityFeeGwei?: number;
}

/**
 * Auto-calibração aplicada (Fase 2b): emitido SÓ quando `ADAPTIVE_THRESHOLDS_ENABLED=true` e o
 * threshold de EV mudou de fato (honesto — não emite quando é só log). Alimenta o card de
 * auto-calibração do painel via a tabela `events` (payload jsonb).
 */
export interface CalibrationAppliedEvent extends BaseEvent {
  type: 'calibration.applied';
  severity: 'info';
  /** Dimensão calibrada (hoje 'global' — o threshold é único; por-protocolo no futuro). */
  dimension: string;
  /** Threshold de EV antigo (USD), antes da injeção. */
  oldThresholdUsd: number;
  /** Threshold de EV novo (USD), recém-calculado. */
  newThresholdUsd: number;
  /** Protocolo top do ranking que motivou (quando disponível). */
  topProtocol?: string | null;
  /** Motivo curto/legível. */
  reason?: string;
}

/**
 * Snapshot diário do saldo da wallet (Fase 2b): emitido 1×/dia (virada de dia UTC) pra desenhar o
 * gráfico de saldo 30d. Vai pra tabela própria `wallet_snapshots` (série temporal), não pra `events`.
 */
export interface WalletSnapshotEvent extends BaseEvent {
  type: 'wallet.snapshot';
  severity: 'info';
  /** Serviço que emitiu (liquidator | ...). */
  service: string;
  /** Saldo em ETH no momento do snapshot. */
  balanceEth: number;
  /** Saldo em USD no momento do snapshot (quando há preço). */
  balanceUsd?: number;
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
 * Agregado comparativo por ESTRATÉGIA (24h) — vai no heartbeat pra o painel mostrar qual estratégia
 * daria/dá mais lucro: liquidação clássica × pré-liquidação Morpho × filler UniswapX. O bot conhece a
 * estratégia com precisão (resolve a ambiguidade filler-vs-arb que existiria derivando da tabela `events`).
 * Em DRY_RUN, `executed`/`netUsd` ficam 0 e `candidates`/`candidateProfitUsd` mostram o POTENCIAL.
 */
export interface HeartbeatStrategyStat {
  strategy: 'classic-liq' | 'pre-liq' | 'filler' | 'arb';
  /** Candidatos LUCRATIVOS vistos na janela (24h). */
  candidates24h: number;
  /** Soma do lucro esperado desses candidatos (USD). */
  candidateProfitUsd24h: number;
  /** Quantos foram disparados de verdade (0 em DRY_RUN). */
  executed24h: number;
  /** Lucro líquido realizado dos executados (USD). */
  netUsd24h: number;
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
  /** Lance de mercado p75 (priority fee gwei) — entre o mediano e o agressivo. */
  marketBribeP75Gwei?: number;
  /** NOSSO lance atual (priority fee gwei) — na Base o priority fee É o bribe prático. */
  ourBribeGwei?: number;
  /** true se o ZEUS auto-ajustou o bribe pra cima por competição (dentro do lucro) — POR DISPATCH. */
  bribeAutoRaised?: boolean;
  /** Motivo do auto-ajuste ('raised-to-market' | 'capped-by-profit'). */
  bribeReason?: string;
  /** Motor 2: true quando o ZEUS LIGOU sozinho a feature de bribe competitivo (nível-feature). */
  competitiveBribeAutoEnabled?: boolean;
  /** Por que ligou (ex.: "N corridas perdidas no gás na última hora"). */
  bribeAutoEnableReason?: string;
}

/**
 * Blocos extras do heartbeat (Fase 2 da cobertura do painel) — todos REUSAM valores que o loop de
 * métricas do bot já computa (health/competidores/cooldowns/kill-switch/edge-pairs). Vão em colunas
 * jsonb de `service_status`. Opcionais → motor que não tem o dado simplesmente omite o bloco.
 */
export interface HeartbeatHealth {
  /** Prontidão dos componentes (espelha o /readyz): nome + ok + detalhe curto. */
  components: { name: string; ok: boolean; detail?: string }[];
}
export interface HeartbeatCompetitor {
  /** Alias conhecido ou endereço encurtado. */
  alias: string;
  /** Categoria inferida (liquidator | generic_arber | mev_searcher | unknown). */
  category: string;
  /** Total de txs observadas do competidor. */
  txs: number;
  /** Lance médio do competidor (priority fee gwei). */
  bribeGwei: number;
  /** Score de ameaça [0..1]. */
  threat: number;
  /** Fase 2b — nº de corridas que ele nos ganhou (head-to-head); 0/omitido até a execução rodar. */
  wonVsUs?: number;
}
export interface HeartbeatCooldown {
  /** Rótulo curto (ex.: "auto-pause"). */
  label: string;
  /** Motivo legível. */
  reason: string;
  /** Ainda ativo? */
  active: boolean;
}
export interface HeartbeatKillSwitch {
  /** Perda acumulada na janela de 24h (USD). */
  loss24hUsd: number;
  /** Limite que dispara o kill switch (USD). */
  limitUsd: number;
  /** Já disparou? */
  triggered: boolean;
}
export interface HeartbeatLatency {
  /** Latência mediana de dispatch (submit→confirmação), em ms. */
  p50Ms: number;
  /** Latência p95 de dispatch, em ms. */
  p95Ms: number;
  /** Nº de amostras na janela (0 = ainda não despachou nada; bloco é omitido). */
  samples: number;
}
export interface HeartbeatReorgs {
  /** Reorgs detectadas na janela (rolling do FinalityTracker). */
  window24h: number;
  /** Tx órfãs recuperadas (re-submetidas com sucesso) pós-reorg. */
  orphansRecovered: number;
  /** Tx órfãs detectadas no total (recuperadas + skip + falha). */
  orphansDetected: number;
}
export interface HeartbeatEdgePair {
  /** Par/grupo (ex.: "WETH/USDC"). */
  pair: string;
  /** Score de persistência empírica. */
  score: number;
  /** Razão de persistência formatada (ex.: "62%"). */
  persistPct: string;
  /** Divergência média (bps). */
  avgBps: number;
  /** Nº de amostras. */
  samples: number;
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
  /** Agregado comparativo por estratégia (clássica × pré-liq × filler) — tela "Estratégias". */
  strategyStats?: HeartbeatStrategyStat[];
  /** Universo vetado por token (porteiro) — tela "Tokens". */
  vettedUniverse?: VettedEntry[];
  /** Estado do filtro de tokens por motor (badge "filtro ligado" na tela "Tokens"). */
  vettingEnforce?: { motor1?: boolean; motor2?: boolean };
  /** ISO do último re-vet do porteiro (freshness "re-vet há Xs" na tela "Tokens"). */
  vettingRevetAt?: string;
  /** Pulso do radar de descoberta (item 2) — opcional (só motores com discovery). */
  discovery?: HeartbeatDiscovery;
  /** Agregados de inteligência (item 3) — opcional (reusa o que o loop de métricas já calcula). */
  intel?: HeartbeatIntel;
  // ── Fase 2 (cobertura do painel): blocos extras, todos opcionais e reusando o loop de métricas ──
  /** Prontidão dos componentes (tela Saúde). */
  health?: HeartbeatHealth;
  /** Top competidores observados (tela Inteligência). */
  competitors?: HeartbeatCompetitor[];
  /** Cooldowns / motivos de auto-pause ativos (tela Saúde). */
  cooldowns?: HeartbeatCooldown[];
  /** Estado do kill switch (perda 24h vs limite) (tela Saúde). */
  killSwitch?: HeartbeatKillSwitch;
  /** Ranking de pares com edge persistente (Motor 2 / tela Inteligência). */
  edgePairs?: HeartbeatEdgePair[];
  /** Latência de dispatch p50/p95 (Fase 2b) — omitido enquanto não há dispatch real. */
  latency?: HeartbeatLatency;
  /** Resiliência de reorg (Motor 1 mainnet) — reorgs na janela + órfãs recuperadas. */
  reorgs?: HeartbeatReorgs;
  /** Diagnóstico de concorrência (item 4) — builders dominantes + nossa posição no bloco (tela Inteligência). */
  competition?: HeartbeatCompetition;
}

/** Diagnóstico de concorrência: quem controla o blockspace + se caímos no fundo do bloco. */
export interface HeartbeatCompetition {
  /** Builders dominantes (por volume de tx de competidores). */
  topBuilders: { alias: string; blocks: number; competitorTxs: number; ourTxs: number }[];
  /** Nossa posição no bloco (janela rolante). samples=0 até executarmos de verdade. */
  position: { samples: number; bottom10pctPct: number; top10pctPct: number; avgRelative: number };
}
