/**
 * @zeus-evm/execution-utils — utilities compartilhadas entre engines (liquidator, backrun, JIT futuro).
 *
 * Contém:
 *   - 4 trackers (PnL, Failure, PositionDedup, GasReserve)
 *   - Gas Oracle EIP-1559
 *   - Event Bus + tipos canônicos ZEUS
 *   - Event Decoder (decoda eventos *Executed do ZeusExecutor)
 *   - Price Utils (formatWei, estimateUsd, gasCostUsd)
 *   - Slippage Cache (cache UniV3 quotes TTL 60s)
 *   - Alerting sinks (Discord embed + Generic webhook)
 *
 * Princípios:
 *   - Logger injetável (LoggerLike interface) — cada app passa o seu pino
 *   - Zero acoplamento com lógica de protocolo (Aave/Compound/Morpho/UniV3 DEX)
 *   - Reusável por TODOS os engines ZEUS sem duplicação
 */

// ─── Trackers ───
export {
  PnlTracker,
  type PnlEvent,
  type PnlEventType,
  type PnlStats,
  type PnlTrackerOpts,
} from './pnlTracker';

export {
  FailureTracker,
  type FailureStats,
  type FailureTrackerOpts,
} from './failureTracker';

export {
  PositionDedupTracker,
  aavePositionKey,
  compoundPositionKey,
  type DedupStatus,
  type DedupStats,
  type DedupTrackerOpts,
} from './positionDedup';

export {
  GasReserveTracker,
  type GasReserveStatus,
  type GasReserveStats,
  type GasReserveTrackerOpts,
} from './gasReserveTracker';

// ─── Gas Oracle EIP-1559 ───
export {
  GasOracle,
  type GasFees,
  type GasOracleOpts,
} from './gasOracle';

// ─── Event Bus ───
export { EventBus, type EventHandler } from './eventBus';
export type {
  ZeusEvent,
  Severity,
  LiquidatorBootEvent,
  LiquidatorShutdownEvent,
  TxConfirmedEvent,
  TxRevertedOnChainEvent,
  TxRevertedPreDispatchEvent,
  PnlKillSwitchTriggeredEvent,
  FailureCooldownActivatedEvent,
  FailureCooldownExpiredEvent,
  GasReserveAlertEvent,
  GasReserveRecoveredEvent,
  DiscoveryTickCompletedEvent,
  WhaleSwapDetectedEvent,
  WhaleSwapVenue,
  BackrunOpportunityFoundEvent,
  BackrunDispatchedEvent,
  BackrunRejectedEvent,
} from './events';

// ─── Event Decoder ───
export {
  decodeLiquidationEvent,
  profitDeltaBps,
  type LiquidationEventName,
  type DecodedLiquidationEvent,
} from './eventDecoder';

// ─── Price Utils ───
export { formatWei, estimateUsd, gasCostUsd } from './priceUtils';

// ─── Slippage Cache ───
export {
  SlippageCache,
  slippageCache,
  cachedQuoteUniswapV3,
} from './slippageCache';

// ─── Bribe Slippage Floor (Audit Pass 4 H-01 protection) ───
export {
  computeBribeSlippageFloor,
  type BribeSlippageFloorParams,
  type BribeSlippageFloorResult,
} from './bribeSlippageFloor';

// ─── Historical Intelligence (Item 15 — DuckDB + EventIngester) ───
export {
  TimeseriesStore,
  EventIngester,
  type TimeseriesStoreOpts,
  type TimeseriesStats,
  type EventIngesterOpts,
  type IngesterStats,
  type HistoricalEvent,
  type EventCategory,
  type EventMode,
  type EventSeverity,
  EVENTS_TABLE_DDL,
  computeTimeDimensions,
  generateEventId,
} from './intelligence';

// ─── Health (Item 12 H3+H7+H8+H10+H11) ───
export {
  startHealthServer,
  BlockStalenessCheck,
  ProcessCheck,
  AutoPauseManager,
  type HealthServerOpts,
  type ReadinessProvider,
  type ReadinessReport,
  type ComponentCheck,
  type BlockStalenessCheckOpts,
  type StalenessResult,
  type StalenessStatus,
  type ProcessCheckOpts,
  type ProcessHealth,
  type ProcessStatus,
  type AutoPauseManagerOpts,
  type AutoPauseStatus,
  type PauseReason,
} from './health';

// ─── Failure Analytics (Item 4 A1+A5 — schema rico + JSONL persistence) ───
export {
  FailureCollector,
  type FailureCollectorOpts,
  type FailureEvent,
  type FailureCategory,
  type FailureAnalyticsStats,
  generateFailureId,
} from './analytics';

// ─── Finality + Reorg Protection (Item 9 R1+R2) ───
export {
  FinalityTracker,
  TxStateMachine,
  type FinalityTrackerOpts,
  type FinalityStats,
  type BlockSnapshot,
  type ReorgEvent,
  type ReorgListener,
  type TxStateMachineOpts,
  type ConfirmationPolicy,
  type TxState,
  type TxEntry,
} from './finality';

// ─── Observability (Item 16B OB1+OB2+OB5 — Tracer + Prometheus + Logger) ───
export {
  Tracer,
  Span,
  createStructuredLogger,
  MetricRegistry,
  STANDARD_METRICS,
  registerStandardMetrics,
  type TracerOpts,
  type SpanData,
  type SpanStatus,
  type StructuredLoggerOpts,
  type MetricDefinition,
  type MetricType,
} from './observability';

// ─── PnL Reconciliation (Item 10 P1+P2+P3+P5+P7) ───
export {
  PnlReconciler,
  attribute,
  suggestAction,
  decodeLastSwap,
  calculateSlippageBps,
  decodeBribeEvent,
  generateReconciliationId,
  buildDigest,
  formatMarkdown,
  sendToDiscord,
  type PnlReconciliation,
  type ReconciliationStats,
  type AttributionCause,
  type PnlReconcilerOpts,
  type ReconcileInput,
  type AttributionInput,
  type AttributionResult,
  type DecodedSwapReceipt,
  type DecodedBribe,
  type DigestOptions,
} from './pnl';

// ─── Competitor Fingerprinting (Item 5 F1+F2) ───
export {
  SenderRegistry,
  BlockHistoryScanner,
  KNOWN_BOTS,
  lookupKnownAlias,
  type CompetitorProfile,
  type CompetitorCategory,
  type CompetitorRegistryStats,
  type SenderRegistryOpts,
  type SenderObserveInput,
  type BlockHistoryScannerOpts,
  type ScannerTargets,
  type ScannerStats,
} from './competitors';

// ─── Alerting Sinks ───
export {
  createDiscordSink,
  type DiscordSinkOpts,
} from './alerting/discordSink';

export {
  createGenericWebhookSink,
  type GenericWebhookSinkOpts,
} from './alerting/genericWebhookSink';

// ─── Mempool subscription (placeholder pra Alchemy/Blocknative premium) ───
export {
  subscribeWhaleSwaps,
  emitSyntheticWhale,
  classifyVenue,
  decodeSwapCalldata,
  type KnownRouters,
  type DecodedSwap,
  type WhaleSwapSubscriptionParams,
} from './mempool/whaleSwapSubscription';
