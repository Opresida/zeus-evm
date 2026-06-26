export * from './types';
export { quoteUniswapV3 } from './uniswap-v3/quoter';
export type { UniswapV3QuoteParams } from './uniswap-v3/quoter';
export {
  quoteUniswapV3MultiHop,
  encodeUniV3Path,
  buildCandidateRoutes,
  type MultiHopRoute,
  type MultiHopQuoteParams,
} from './uniswap-v3/multiHopQuoter';
export { quoteAerodrome } from './aerodrome/router';
export type { AerodromeQuoteParams } from './aerodrome/router';
export { quoteUniswapV2 } from './uniswap-v2/quoter';
export type { UniswapV2QuoteParams } from './uniswap-v2/quoter';
export { quoteSlipstream } from './slipstream/quoter';
export type { SlipstreamQuoteParams } from './slipstream/quoter';
export { bestSwapAcrossDexes } from './bestSwap';
export type { BestSwapOpts } from './bestSwap';

// ─── Pricing local (fundação do MIS — Motor 2) ───
export {
  uniV3SpotPrice1e18,
  uniV3SpotPriceInverse1e18,
  tickToSqrtPriceX96,
  aeroVolatileSpotPrice1e18,
  aeroStableSpotPrice1e18,
  aeroSpotPrice1e18,
  priceDivergenceBps,
  arbDirection,
  PRICING_WAD,
  UNIV3_POOL_ABI,
  AERO_POOL_ABI,
  getUniV3PoolAddress,
  getAeroPoolAddress,
  getSlipstreamPoolAddress,
  getV2PoolAddress,
  readUniV3PoolState,
  readAeroPoolState,
  uniV3StateToSpot,
  aeroStateToSpot,
  getTraderJoePairs,
  readLBPairState,
  quoteTraderJoe,
  lbSwapOutToSpot1e18,
  LB_FACTORY_ABI,
  LB_PAIR_ABI,
  type UniV3PoolState,
  type AeroPoolState,
  type LBPairRef,
  type LBPairState,
} from './pricing';
