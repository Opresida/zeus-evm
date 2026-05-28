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
  morphoPositionKey,
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

// ─── Failure Analytics (Item 4 A1+A2+A3+A4+A5+A8) ───
export {
  FailureCollector,
  BlockPositionTracker,
  CompetitorResolver,
  CalibrationDriftTracker,
  buildFailureDigest,
  formatFailureMarkdown,
  sendFailureDigestToDiscord,
  type FailureCollectorOpts,
  type FailureEvent,
  type FailureCategory,
  type FailureAnalyticsStats,
  type BlockPositionTrackerOpts,
  type BlockPositionInfo,
  type CompetitorResolverOpts,
  type ResolvedCompetitor,
  type CalibrationDriftTrackerOpts,
  type DriftSample,
  type DriftDimension,
  type DriftStats,
  type FailureDigestOptions,
  generateFailureId,
} from './analytics';

// ─── Finality + Reorg Protection (Item 9 R1+R2+R3+R5+R7) ───
export {
  FinalityTracker,
  TxStateMachine,
  CacheInvalidator,
  OrphanRecoveryManager,
  ReorgAnalytics,
  type FinalityTrackerOpts,
  type FinalityStats,
  type BlockSnapshot,
  type ReorgEvent,
  type ReorgListener,
  type TxStateMachineOpts,
  type ConfirmationPolicy,
  type TxState,
  type TxEntry,
  type CacheInvalidatorOpts,
  type CacheFlushFn,
  type InvalidationStats,
  type OrphanRecoveryManagerOpts,
  type OrphanContext,
  type OrphanRecoveryStats,
  type ReorgAnalyticsOpts,
  type ReorgSample,
  type ReorgAggregateStats,
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

// ─── PnL Reconciliation (Item 10 P1+P2+P3+P4+P5+P6+P7+P8) ───
export {
  PnlReconciler,
  PnlAggregator,
  WINDOW_MS,
  attribute,
  suggestAction,
  decodeLastSwap,
  calculateSlippageBps,
  decodeBribeEvent,
  generateReconciliationId,
  buildDigest,
  formatMarkdown,
  sendToDiscord,
  buildWeeklyDigest,
  formatWeeklyMarkdown,
  sendWeeklyDigestToDiscord,
  computeInclusionCost,
  formatBreakdownLog,
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
  type WeeklyDigestData,
  type PnlAggregatorOpts,
  type AggregationDimension,
  type AggregationResult,
  type WindowName,
  type InclusionCostInput,
  type InclusionCostBreakdown,
} from './pnl';

// ─── Competitor Fingerprinting (Item 5 F1+F2+F3+F4+F5+F6+F7+F8+F9) ───
export {
  SenderRegistry,
  BlockHistoryScanner,
  GasFingerprintTracker,
  ActivityPatternTracker,
  buildCompetitorDigest,
  formatCompetitorMarkdown,
  sendCompetitorDigestToDiscord,
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
  type GasFingerprintTrackerOpts,
  type GasFingerprint,
  type ActivityPatternOpts,
  type ActivityPattern,
  type CompetitorDigestOptions,
  BuilderAttributionTracker,
  KNOWN_BUILDERS,
  lookupBuilder,
  type BuilderAttributionOpts,
  type BuilderStats,
  computeAffinity,
  topSpecialistsPerProtocol,
  classifyMultiSignal,
  applyClassification,
  CooccurrenceAnalyzer,
  type ProtocolAffinity,
  type ProtocolKey,
  type SpecializationLevel,
  type ClassifierSignals,
  type ClassificationResult,
  type CooccurrenceAnalyzerOpts,
  type BlockObservation,
  type CooccurrenceLink,
  type CooccurrenceCluster,
} from './competitors';

// ─── Arb / Motor 2 (Token Safety) ───
export {
  buildArbAllowlist,
  isArbTokenAllowed,
  checkArbPair,
  checkArbRoute,
  type ArbAllowlist,
} from './arb';

// ─── Alerting Sinks ───
export {
  createDiscordSink,
  type DiscordSinkOpts,
} from './alerting/discordSink';

export {
  createGenericWebhookSink,
  type GenericWebhookSinkOpts,
} from './alerting/genericWebhookSink';

// ─── Oracle Staleness (Grupo B — multi-chain Chainlink) ───
export {
  ChainlinkStalenessChecker,
  CHAINLINK_AGGREGATOR_V3_ABI,
  AAVE_ORACLE_GET_SOURCE_ABI,
  type StalenessCheckResult,
  type ChainlinkStalenessOpts,
} from './oracle';

// ─── Protocol Pause Detection (Grupo B — multi-chain Aave/Compound) ───
export {
  PauseDetector,
  AAVE_POOL_PAUSED_ABI,
  COMET_PAUSED_ABI,
  type PauseCheckResult,
  type PauseDetectorOpts,
} from './protocols';

// ─── Chain Profitability Score (Doutrina 2026-05-27) ───
export {
  ChainProfitabilityScorer,
  formatScoreRankingMarkdown,
  SCORE_WEIGHTS,
  type ChainProfitabilityScorerOpts,
  type ChainObservation,
  type ChainScore,
  type ScoreComponents,
} from './scoring';

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
