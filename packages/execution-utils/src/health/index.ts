/**
 * Health module — Item 12 do checklist 16-items.
 *
 * H8+H11: HTTP server + UptimeRobot (entregue na release anterior)
 * H3: BlockStalenessCheck (esta release)
 * H7: ProcessCheck (esta release)
 * H10: AutoPauseManager (esta release)
 */

export {
  startHealthServer,
  type HealthServerOpts,
  type ReadinessProvider,
  type ReadinessReport,
  type ComponentCheck,
} from './healthServer';

export {
  BlockStalenessCheck,
  type BlockStalenessCheckOpts,
  type StalenessResult,
  type StalenessStatus,
} from './blockStalenessCheck';

export {
  ProcessCheck,
  type ProcessCheckOpts,
  type ProcessHealth,
  type ProcessStatus,
} from './processCheck';

export {
  AutoPauseManager,
  type AutoPauseManagerOpts,
  type AutoPauseStatus,
  type PauseReason,
} from './autoPauseManager';
