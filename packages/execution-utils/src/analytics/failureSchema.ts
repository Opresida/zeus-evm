/**
 * Failure Analytics — Item 4 do checklist 16-items.
 *
 * Schema rico pra cada failure (vs PnL tracker que só diz "perdi X USD").
 * Captura CONTEXT pra post-mortem agregado: por que perdeu, quem ganhou, gas pago,
 * rota usada, posição no bloco, calibration drift.
 *
 * **Por que importa:** o real alpha está nas operações PERDIDAS, não nas ganhas.
 * Sem schema estruturado, derrotas viram log line que some no JSONL.
 *
 * Schema ML-friendly (alimenta IA futura Item 16A):
 *  - Numericals discretos por componente (gas_usd_paid, slippage_real_bps, etc)
 *  - Categoricals (category, primary_cause, relay_used)
 *  - Temporal (timestamp, hour_utc, weekday)
 *  - JSON payload pra dados não-estruturados
 */

/**
 * Categorização canônica do failure — alimenta agregação por causa-raiz.
 * Detecta via heurística no attributionAnalyzer (não implementado nesta release).
 */
export type FailureCategory =
  | 'reverted_on_chain'         // tx submetida reverteu por erro de protocolo
  | 'lost_race'                 // outro bot liquidou primeiro
  | 'sim_passed_but_reverted'   // simulação OK mas on-chain reverteu (state drift)
  | 'unprofitable_after_slippage' // slippage real > esperado, profit < gas
  | 'frontrun_by_bot'           // sender conhecido entrou na frente (tx index menor)
  | 'sandwich_loss'             // sandwich attack detectado pós-tx
  | 'gas_outbid'                // outro bot pagou priorityFee maior
  | 'simulation_mismatch'       // delta entre sim profit e real > threshold
  | 'orphaned_in_reorg'         // tx confirmou em bloco reorged
  | 'rejected_pre_dispatch'     // gate (kill/cooldown/dedup/gas/stale) bloqueou
  | 'unknown';

/**
 * Schema canonical do FailureEvent.
 * Campos opcionais permitem normalizar failures de naturezas diferentes
 * (pre-dispatch reject vs on-chain revert vs orphan) num único schema.
 */
export interface FailureEvent {
  // ─── Identificação ───
  id: string;                       // ULID-like gerado no collector
  timestamp: number;                // Unix ms
  chain: string;                    // 'Base', 'Arbitrum', etc
  mode: 'dryrun' | 'testnet' | 'mainnet';
  protocol?: string;                // 'aave-v3', 'compound-v3', 'morpho-blue', 'backrun'

  // ─── Classificação ───
  category: FailureCategory;
  /** Confidence da classificação (0-1). 1.0 = certeza, 0.5 = heurística incerta. */
  category_confidence: number;
  /** Nossa tx hash (se chegamos a submeter). */
  our_tx_hash?: string;

  // ─── Custos REAIS (preenchidos quando aplicável) ───
  our_gas_used?: string;            // bigint como string (precision-safe JSON)
  our_gas_usd_lost?: number;        // USD gasto em gas que não voltou
  our_priority_fee_wei?: string;
  our_max_fee_per_gas_wei?: string;
  our_tx_index?: number;            // posição no bloco (0 = primeiro)

  // ─── Bloco context ───
  block_number?: string;
  block_base_fee_wei?: string;
  block_total_txs?: number;

  // ─── Expected vs Realized (pra calibration drift) ───
  expected_profit_usd?: number;     // do calculator
  realized_profit_usd?: number;     // do event decoder
  profit_delta_bps?: number;        // (realized - expected) / expected
  expected_slippage_bps?: number;
  realized_slippage_bps?: number;
  slippage_delta_bps?: number;

  // ─── Competitor (preenchido async via post-mortem em A3 futura) ───
  /** Sender que ganhou a oportunidade no mesmo bloco. */
  competitor_winner_sender?: string;
  /** Tag conhecido se sender está no registry (item 5). */
  competitor_winner_alias?: string;
  /** Gas que o competidor pagou (pra detectar gas race). */
  competitor_winner_priority_fee_wei?: string;
  /** Posição relativa: positivo = competidor entrou ANTES. */
  competitor_position_delta?: number;

  // ─── Relay/route used ───
  relay_used?: 'flashbots' | 'blocknative' | 'atlas' | 'public_mempool' | 'none';
  relay_submit_elapsed_ms?: number;

  // ─── Opportunity context ───
  opportunity_id?: string;          // borrower address ou pair id
  expected_bribe_bps?: number;
  realized_bribe_usd?: number;

  // ─── Pre-dispatch context (se rejected_pre_dispatch) ───
  rejected_at_gate?: 'kill_switch' | 'cooldown' | 'gas_reserve' | 'dedup' | 'sim' | 'stale_check' | 'oracle';
  reject_reason?: string;

  // ─── Free-form payload pra dados que não cabem em campos fixos ───
  payload: Record<string, unknown>;
}

/**
 * Stats agregados sobre falhas coletadas — pro Discord daily digest.
 */
export interface FailureAnalyticsStats {
  total: number;
  byCategory: Record<FailureCategory, number>;
  totalUsdLost: number;
  windowMs: number;
}

/**
 * Gera ID lexicographically sortable (timestamp embedded).
 */
export function generateFailureId(timestamp: number): string {
  const tsHex = timestamp.toString(16).padStart(12, '0');
  const random = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `fail-${tsHex}-${random}`;
}
