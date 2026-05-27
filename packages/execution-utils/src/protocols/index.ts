/**
 * Protocol utilities — checagens shared entre Aave/Compound/Morpho/Moonwell.
 *
 * Multi-chain ready: todas as funções recebem chain-specific addresses via params.
 */

export {
  PauseDetector,
  AAVE_POOL_PAUSED_ABI,
  COMET_PAUSED_ABI,
  type PauseCheckResult,
  type PauseDetectorOpts,
} from './pauseDetector';
