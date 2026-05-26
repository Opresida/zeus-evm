/**
 * Backrun module — barrel export.
 */

export type {
  WhaleSwap,
  WhaleSwapVenue,
  BackrunOpportunity,
  PriceImpactInput,
  PriceImpactResult,
} from './types';

export { estimatePriceImpact } from './priceImpactCalculator';

export {
  planBackrun,
  findPairForWhale,
  type BackrunPlanParams,
} from './backrunPlanner';

export {
  validateBackrunProfit,
  type ValidateBackrunParams,
  type ValidateBackrunResult,
} from './profitValidator';
