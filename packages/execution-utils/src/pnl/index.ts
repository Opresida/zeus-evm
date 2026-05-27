/**
 * PnL Reconciliation module — Item 10 do checklist 16-items.
 *
 * Esta release entrega P1+P2+P3+P5:
 *  - PnlReconciliation schema rico
 *  - PnlReconciler core (expected vs realized + attribution + JSONL)
 *  - slippageRealTracker (decoda Swap UniV3/Aerodrome)
 *  - bribeRealTracker (decoda BribePaid + BribeCoinbaseFallback)
 *  - attributionAnalyzer (heurística de decomposição)
 *  - suggestAction (recomendações automatizáveis)
 *
 * Próximos componentes (P4, P6-P10):
 *  - inclusionCostBreakdown (priorityFee + bribe + L1 cost separados)
 *  - aggregator (rolling 7d/30d/90d por par/protocolo/horário)
 *  - reporter (daily Discord + weekly Markdown)
 *  - pnlStore JSONL rotação (já parcialmente implementado em PnlReconciler)
 *  - integração com pnlTracker.ts (deprecar ou conviver)
 */

export {
  type PnlReconciliation,
  type ReconciliationStats,
  type AttributionCause,
  generateReconciliationId,
} from './pnlSchema';

export {
  PnlReconciler,
  type PnlReconcilerOpts,
  type ReconcileInput,
} from './pnlReconciler';

export {
  attribute,
  suggestAction,
  type AttributionInput,
  type AttributionResult,
} from './attributionAnalyzer';

export {
  decodeLastSwap,
  calculateSlippageBps,
  type DecodedSwapReceipt,
} from './slippageRealTracker';

export {
  decodeBribeEvent,
  type DecodedBribe,
} from './bribeRealTracker';

export {
  buildDigest,
  formatMarkdown,
  sendToDiscord,
  type DigestOptions,
} from './pnlReporter';

export {
  PnlAggregator,
  WINDOW_MS,
  type PnlAggregatorOpts,
  type AggregationDimension,
  type AggregationResult,
  type WindowName,
} from './pnlAggregator';
