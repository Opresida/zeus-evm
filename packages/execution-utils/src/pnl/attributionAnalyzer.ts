/**
 * AttributionAnalyzer — Item 10 P5 do checklist.
 *
 * Heurística que decompõe `net_delta_usd` em causas-raiz. Roda local (zero RPC),
 * baseado nos deltas já calculados pelo reconciler.
 *
 * Filosofia: heurísticas explícitas + documentadas. Quando IA chegar (Item 16A),
 * substitui essa lógica por modelo treinado mantendo mesma interface
 * (`AttributionResult` schema).
 */

import type {
  PnlReconciliation,
  AttributionCause,
} from './pnlSchema';

export interface AttributionInput {
  expected: PnlReconciliation['expected'];
  realized: PnlReconciliation['realized'];
  deltas: PnlReconciliation['deltas'];
  inclusion_cost: PnlReconciliation['inclusion_cost'];
  context: PnlReconciliation['context'];
}

export interface AttributionResult {
  primary_cause: AttributionCause;
  confidence: number;
  root_cause_details: string;
  automatable: boolean;
}

/**
 * Decomposição de "por que delta vs expected".
 *
 * Ordem de avaliação (primeira heurística que dispara vence):
 *   1. Dentro de banda ±100bps → 'within_normal_band'
 *   2. Slippage real >> estimado (delta > 150bps) → 'pool_slippage'
 *   3. Gas usado >> estimado (>50% acima) → 'gas_spike'
 *   4. Bribe pago > esperado significativo → 'bribe_overshoot'
 *   5. Competitor conhecido ganhou no bloco → 'frontrun_loss'
 *   6. Reorg recovery context → 'reorg_recovery_cost'
 *   7. Default → 'oracle_drift' com baixa confidence
 */
export function attribute(input: AttributionInput): AttributionResult {
  const { expected, realized, deltas, context } = input;

  // 1. Dentro da banda normal — sem ação necessária
  if (Math.abs(deltas.profit_delta_bps) < 100) {
    return {
      primary_cause: 'within_normal_band',
      confidence: 0.95,
      root_cause_details: `drift ${deltas.profit_delta_bps}bps dentro de ±100bps`,
      automatable: false,
    };
  }

  // 6. Reorg recovery (se context indica)
  if (context.finality_status === 'orphaned') {
    return {
      primary_cause: 'reorg_recovery_cost',
      confidence: 0.85,
      root_cause_details: 'tx orphaned em reorg, recovery custou gas',
      automatable: true,
    };
  }

  // 5. Frontrun loss (competitor conhecido no bloco)
  if (context.competitor_winner_sender) {
    return {
      primary_cause: 'frontrun_loss',
      confidence: 0.80,
      root_cause_details: `competitor ${context.competitor_winner_sender.slice(0, 10)} ganhou`,
      automatable: true,
    };
  }

  // 2. Pool slippage (slippage real muito acima do estimado)
  if (
    deltas.slippage_delta_bps !== undefined &&
    deltas.slippage_delta_bps > 150
  ) {
    return {
      primary_cause: 'pool_slippage',
      confidence: 0.85,
      root_cause_details: `slippage real ${realized.slippage_bps}bps vs esperado ${expected.slippage_bps}bps (+${deltas.slippage_delta_bps}bps)`,
      automatable: true,
    };
  }

  // 3. Gas spike (gas usado bem acima do estimado)
  if (
    expected.gas_usd_estimated !== undefined &&
    expected.gas_usd_estimated > 0 &&
    deltas.gas_delta_usd / expected.gas_usd_estimated > 0.5
  ) {
    return {
      primary_cause: 'gas_spike',
      confidence: 0.75,
      root_cause_details: `gas $${realized.gas_usd_actual.toFixed(3)} vs esperado $${expected.gas_usd_estimated.toFixed(3)} (+${((deltas.gas_delta_usd / expected.gas_usd_estimated) * 100).toFixed(0)}%)`,
      automatable: true,
    };
  }

  // 4. Bribe overshoot (pagou bribe acima do necessário)
  if (
    deltas.bribe_delta_usd !== undefined &&
    deltas.bribe_delta_usd > 0 &&
    realized.bribe_usd_paid !== undefined &&
    realized.bribe_usd_paid > expected.net_profit_usd_estimated * 0.5
  ) {
    return {
      primary_cause: 'bribe_overshoot',
      confidence: 0.70,
      root_cause_details: `bribe $${realized.bribe_usd_paid.toFixed(3)} = ${((realized.bribe_usd_paid / expected.profit_usd) * 100).toFixed(0)}% do profit`,
      automatable: true,
    };
  }

  // Default — oracle drift baixa confidence
  return {
    primary_cause: 'oracle_drift',
    confidence: 0.30,
    root_cause_details: `delta ${deltas.profit_delta_bps}bps sem causa identificável — possível drift de oracle ou condição não rastreada`,
    automatable: false,
  };
}

/**
 * Sugestão automatizável baseada na attribution.
 * Retorna texto curto pra Discord/log quando `automatable=true`.
 */
export function suggestAction(result: AttributionResult, recon: PnlReconciliation): string | null {
  if (!result.automatable) return null;

  switch (result.primary_cause) {
    case 'pool_slippage':
      return `Considerar mudar venue/fee tier — slippage atual ${recon.realized.slippage_bps}bps`;
    case 'gas_spike':
      return 'Subir GAS_MAX_FEE_MULTIPLIER ou pausar em horários de spike';
    case 'bribe_overshoot':
      return 'Reduzir BRIBE_DEFAULT_BPS — bribe acima do necessário';
    case 'frontrun_loss':
      return `Competitor ${recon.context.competitor_winner_sender?.slice(0, 10)} agressivo — calibrar bribe higher nesse window`;
    case 'reorg_recovery_cost':
      return 'Subir confirmations required pra evitar contar profit em órfão';
    default:
      return null;
  }
}
