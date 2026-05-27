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
