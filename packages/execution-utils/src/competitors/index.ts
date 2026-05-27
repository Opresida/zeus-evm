/**
 * Competitor Fingerprinting module — Item 5 do checklist.
 *
 * Esta release entrega F1+F2:
 *  - SenderRegistry: profile + lookup O(1) + snapshot persistente
 *  - BlockHistoryScanner: background READ-ONLY que popula registry
 *  - Heurística básica de classificação (liquidator vs arber vs MEV)
 *  - knownBotsRegistry pra cross-ref com aliases públicos
 *
 * Próximos componentes (F3-F11, ~24h):
 *  - gasFingerprintTracker (p50/p95/p99 sliding window real, não running max)
 *  - activityPatternTracker (refinamento temporal)
 *  - protocolAffinityTracker (USD value tracking)
 *  - builderAttributionTracker (cross-ref block.miner)
 *  - competitorClassifier (heurísticas avançadas)
 *  - cooccurrenceAnalyzer (squad detection)
 *  - competitorReporter (weekly Discord digest)
 */

export {
  type CompetitorProfile,
  type CompetitorCategory,
  type CompetitorRegistryStats,
  KNOWN_BOTS,
  lookupKnownAlias,
} from './senderSchema';

export {
  SenderRegistry,
  type SenderRegistryOpts,
  type UpdateInput as SenderObserveInput,
} from './senderRegistry';

export {
  BlockHistoryScanner,
  type BlockHistoryScannerOpts,
  type ScannerTargets,
  type ScannerStats,
} from './blockHistoryScanner';
