/**
 * Failure Analytics — Item 4 do checklist 16-items.
 *
 * Componentes nesta release (A1+A5):
 *  - FailureEvent schema rico (60+ campos por failure)
 *  - FailureCollector com JSONL rotação diária + rolling stats 24h
 *
 * Próximos componentes (A2-A9):
 *  - blockPositionTracker (txIndex relativo no bloco)
 *  - competitorResolver (post-mortem assíncrono — quem ganhou)
 *  - calibrationDriftTracker (rolling 7d slippage estimado vs real)
 *  - relayAnalyzer (qual relay usado em cada failure)
 *  - failureReporter (daily Discord digest + weekly Markdown)
 *  - attributionAnalyzer (decomposição "por que perdeu" em causas)
 */

export {
  type FailureEvent,
  type FailureCategory,
  type FailureAnalyticsStats,
  generateFailureId,
} from './failureSchema';

export {
  FailureCollector,
  type FailureCollectorOpts,
} from './failureCollector';

export {
  BlockPositionTracker,
  type BlockPositionTrackerOpts,
  type BlockPositionInfo,
} from './blockPositionTracker';

export {
  CompetitorResolver,
  type CompetitorResolverOpts,
  type ResolvedCompetitor,
} from './competitorResolver';

export {
  CalibrationDriftTracker,
  type CalibrationDriftTrackerOpts,
  type DriftSample,
  type DriftDimension,
  type DriftStats,
} from './calibrationDriftTracker';
