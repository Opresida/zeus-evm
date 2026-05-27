/**
 * Finality module — Item 9 R1+R2 do checklist 16-items.
 *
 * Componentes nesta release:
 *  - FinalityTracker: detecção de reorg via ring buffer + parent hash validation
 *  - TxStateMachine: state machine submitted → mempool → soft → confirmed → finalized
 *
 * Próximos componentes (R3-R7):
 *  - reorgEventBus + cacheInvalidator (flush slippage/oracle em reorg)
 *  - confirmationPolicy (N confs por categoria)
 *  - orphanRecovery (re-submit automático com gas atualizado)
 *  - reorgAnalytics (rolling 30d por horário/builder/depth)
 */

export {
  FinalityTracker,
  type FinalityTrackerOpts,
  type FinalityStats,
  type BlockSnapshot,
  type ReorgEvent,
  type ReorgListener,
} from './finalityTracker';

export {
  TxStateMachine,
  type TxStateMachineOpts,
  type ConfirmationPolicy,
  type TxState,
  type TxEntry,
} from './txStateMachine';

export {
  CacheInvalidator,
  type CacheInvalidatorOpts,
  type CacheFlushFn,
  type InvalidationStats,
} from './cacheInvalidator';

export {
  OrphanRecoveryManager,
  type OrphanRecoveryManagerOpts,
  type OrphanContext,
  type OrphanRecoveryStats,
} from './orphanRecoveryManager';

export {
  ReorgAnalytics,
  type ReorgAnalyticsOpts,
  type ReorgSample,
  type ReorgAggregateStats,
} from './reorgAnalytics';
