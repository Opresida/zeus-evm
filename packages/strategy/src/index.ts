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

// Executor (calldata + simulation)
export { ZEUS_EXECUTOR_ABI } from './executor/abi';
export {
  buildSwapSteps,
  buildArbitrageCalldata,
  buildFlashloanCalldata,
  type SolidityNumSwapStep,
  type BuildArbCalldataParams,
  type BuildFlashloanCalldataParams,
} from './executor/txBuilder';
export {
  simulateArbitrage,
  type SimulationResult,
  type SimulateParams,
} from './executor/simulator';
