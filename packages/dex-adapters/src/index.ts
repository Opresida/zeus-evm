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
} from './pricing';
