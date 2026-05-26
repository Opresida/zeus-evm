// Opportunities (detection)
export {
  findCrossDexArb,
  type CrossDexOpportunity,
  type FindArbParams,
} from './opportunities/crossDex';
export {
  quoteFanout,
  type FanoutParams,
} from './opportunities/quoteFanout';
export {
  filterOpportunity,
  type FilterCriteria,
  type FilterResult,
} from './opportunities/filters';

// Backrun (dislocation arb)
export {
  estimatePriceImpact,
  planBackrun,
  findPairForWhale,
  validateBackrunProfit,
  type WhaleSwap,
  type WhaleSwapVenue,
  type BackrunOpportunity,
  type PriceImpactInput,
  type PriceImpactResult,
  type BackrunPlanParams,
  type ValidateBackrunParams,
  type ValidateBackrunResult,
} from './opportunities/backrun';

// Executor (calldata + simulation)
export { ZEUS_EXECUTOR_ABI } from './executor/abi';
export {
  buildSwapSteps,
  buildArbitrageCalldata,
  buildFlashloanCalldata,
  buildBackrunCalldata,
  buildLiquidationWithBribeCalldata,
  buildCompoundLiquidationWithBribeCalldata,
  buildMorphoLiquidationWithBribeCalldata,
  validateBribeConfig,
  NO_BRIBE,
  type SolidityNumSwapStep,
  type BuildArbCalldataParams,
  type BuildFlashloanCalldataParams,
  type BuildBackrunCalldataParams,
  type BuildLiquidationWithBribeParams,
  type BuildCompoundLiquidationWithBribeParams,
  type BuildMorphoLiquidationWithBribeParams,
  type BribeConfig,
} from './executor/txBuilder';
export {
  simulateArbitrage,
  type SimulationResult,
  type SimulateParams,
} from './executor/simulator';
