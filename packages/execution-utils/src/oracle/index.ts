/**
 * Oracle module — utilities pra checagem de price feeds.
 *
 * Multi-chain ready: Chainlink usa MESMA ABI em Base/Arb/OP/Polygon/Avalanche/Mainnet.
 */

export {
  ChainlinkStalenessChecker,
  CHAINLINK_AGGREGATOR_V3_ABI,
  AAVE_ORACLE_GET_SOURCE_ABI,
  type StalenessCheckResult,
  type ChainlinkStalenessOpts,
} from './chainlinkStaleness';
