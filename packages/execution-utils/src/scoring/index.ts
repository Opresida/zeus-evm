/**
 * Scoring module — decisão científica de onde concentrar capital.
 *
 * Doutrina ZEUS (2026-05-27): expandir por oportunidade estrutural,
 * não por chain. Capital vai pra combo (chain × protocol) com maior score.
 */

export {
  ChainProfitabilityScorer,
  formatScoreRankingMarkdown,
  SCORE_WEIGHTS,
  type ChainProfitabilityScorerOpts,
  type ChainObservation,
  type ChainScore,
  type ScoreComponents,
} from './chainProfitabilityScorer';

// ─── OIE Fase 4 — Opportunity Score (primitivo de ranking universal) ───
export {
  scoreOpportunity,
  rankOpportunities,
  scoreBackrunOpportunity,
  scoreLiquidationOpportunity,
  oevRecaptureFor,
  OPPORTUNITY_WEIGHTS,
  OPPORTUNITY_NORMALIZE,
  GAS_WAR_PRIORS,
  OEV_RECAPTURE_PRIORS,
  type OpportunityScoreInput,
  type OpportunityScore,
  type OpportunityScoreComponents,
  type RankedOpportunity,
  type GasWarLevel,
  type BackrunOpportunityScoreInput,
  type LiquidationOpportunityScoreInput,
  type LiquidationOpportunityScore,
} from './opportunityScorer';

// ─── OIE Fases 2-3 — Protocol / Pool / Token Score ───
export {
  scoreDimension,
  rankDimension,
  formatDimensionRankingMarkdown,
  DIMENSION_WEIGHTS,
  DIMENSION_NORMALIZE,
  type Dimension,
  type DimensionStats,
  type DimensionScore,
  type DimensionScoreComponents,
  type DimensionScoreOpts,
  type DimensionWeights,
} from './dimensionScorer';

export {
  queryDimensionStats,
  buildDimensionStatsSql,
  SUCCESS_CATEGORIES,
  FAILED_CATEGORIES,
  OBSERVATION_VALUE_CATEGORIES,
  type DimensionStatsQueryOpts,
} from './dimensionStatsQuery';

// ─── OIE Etapa C — thresholds adaptativos (auto-ajuste) ───
export {
  computeAdaptiveThresholds,
  type AdaptiveThresholds,
  type AdaptiveThresholdsDeps,
} from './adaptiveThresholds';

// ─── #5 automação — calibração de slippage por DEX (seed do Dune) ───
export {
  slippageBpsFor,
  routeSlippageBps,
  effectiveMaxSlippageBps,
  normalizeDexKey,
  sizeBucketFor,
  SLIPPAGE_CALIBRATION_SOURCE,
  type SizeBucket,
} from './slippageCalibration';
