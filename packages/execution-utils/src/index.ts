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
