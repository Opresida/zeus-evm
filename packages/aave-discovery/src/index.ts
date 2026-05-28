/**
 * @zeus-evm/aave-discovery — discovery shared package.
 *
 * Pacote reusável de descoberta de positions liquidáveis Aave V3.
 * Consumido por `apps/liquidator` (dispatch real) e `apps/monitor` (DRY_RUN observação).
 */

export { NOOP_LOGGER, type LoggerLike } from './logger';
export {
  POOL_ABI,
  POOL_ADDRESSES_PROVIDER_ABI,
  POOL_ADDRESSES_PROVIDER_BY_CHAIN,
  POOL_DATA_PROVIDER_ABI,
  ERC20_VIEW_ABI,
} from './abi';
export {
  buildAaveReservesCache,
  getReserveInfo,
  type ReserveInfo,
  type AaveReservesCache,
} from './reserves';
export {
  fetchAaveV3Candidates,
  fetchHealthFactorsBatch,
  resolveBorrowerPositionPair,
  resolveAllBorrowerPositionPairs,
  discoverAaveLiquidatablePositions,
  fetchAaveBorrowersOnChain,
  discoverAaveLiquidatablePositionsOnChain,
} from './discovery';
export { BorrowerCache, type BorrowerCacheOpts } from './borrowerCache';
export type { AaveCandidate, AaveLiquidatablePosition } from './types';
