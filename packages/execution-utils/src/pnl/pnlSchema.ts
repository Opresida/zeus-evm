/**
 * PnL Reconciliation — Item 10 do checklist 16-items.
 *
 * Schema rico de "expected vs realized" por tx, com decomposição automática
 * de "por que diferente" via attributionAnalyzer.
 *
 * Diferenciação:
 *  - `pnlTracker`: rolling 24h pra kill switch (focado em $$ perdido)
 *  - `intelligenceStore` (item 15): dataset agregado cross-event
 *  - `failureCollector` (item 4): só failures
 *  - **PnL Reconciliation (este)**: TODA tx confirmed com decomposição
 *
 * Por que importa: SEM ISSO, é impossível otimizar. Saber só "perdi $5" não
 * diz NADA. Saber "perdi $5 por slippage real 320bps vs estimado 100bps no par
 * WBTC/USDC fee 0.30%" → ação concreta possível (mudar pra fee 0.05%).
 *
 * Schema ML-friendly:
 *  - Numericals discretos por seção (expected, realized, deltas)
 *  - Categoricals (protocol, venue, attribution.primary_cause)
 *  - Temporal (timestamp, hour_utc via item 15)
 *  - JSON payload pra dados não estruturados
 */

export type AttributionCause =
  | 'within_normal_band'        // ±100bps drift, operação normal
  | 'pool_slippage'             // slippage real > estimado em N bps
  | 'gas_spike'                 // gas usado >> estimado
  | 'bribe_overshoot'           // bribe pagou mais do que necessário
  | 'frontrun_loss'             // perda atribuída a competitor que entrou antes
  | 'oracle_drift'              // preço oracle desviou do real durante exec
  | 'reorg_recovery_cost'       // perda por retry pós-orphan
  | 'unknown';

/**
 * Reconciliation completa de 1 tx confirmed.
 * Cada campo opcional permite degradação graciosa (preenche o que dá).
 */
export interface PnlReconciliation {
  // ─── Identidade ───
  id: string;
  timestamp: number;
  chain: string;
  protocol: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'morpho-preliq' | 'backrun' | 'arb';
  tx_hash: string;
  block_number: bigint;

  // ─── Expected (do calculator pré-tx) ───
  expected: {
    profit_wei: bigint;
    profit_usd: number;
    flashloan_amount_wei?: bigint;
    swap_output_wei?: bigint;
    slippage_bps?: number;
    gas_units_estimated?: bigint;
    gas_usd_estimated?: number;
    bribe_bps?: number;
    min_bribe_wei?: bigint;
    net_profit_usd_estimated: number;       // expected - gas - bribe
  };

  // ─── Realized (do receipt + events) ───
  realized: {
    profit_wei: bigint;
    profit_usd: number;
    swap_output_wei?: bigint;               // do event Swap (UniV3/Aerodrome)
    slippage_bps?: number;                  // calculado: (expected - real) / expected
    gas_units_used: bigint;
    gas_usd_actual: number;
    bribe_wei_paid?: bigint;                // do event BribePaid
    bribe_usd_paid?: number;
    net_profit_usd: number;                 // real - gas - bribe
  };

  // ─── Deltas (decomposição "por que diferente") ───
  deltas: {
    profit_delta_bps: number;               // (realized.profit - expected.profit) / expected
    profit_delta_usd: number;
    slippage_delta_bps?: number;            // realized.slippage - expected.slippage
    gas_delta_usd: number;                  // realized.gas - expected.gas
    bribe_delta_usd?: number;
    net_delta_usd: number;
  };

  // ─── Inclusion cost breakdown ───
  inclusion_cost: {
    priority_fee_wei_paid?: bigint;
    priority_fee_usd_paid?: number;
    base_fee_wei_paid?: bigint;             // queimado, não vai pra ninguém
    base_fee_usd_paid?: number;
    bribe_coinbase_usd_paid?: number;
    total_inclusion_usd: number;
    inclusion_as_percent_of_profit: number; // 0-1
  };

  // ─── Attribution ───
  attribution: {
    primary_cause: AttributionCause;
    confidence: number;                     // 0-1
    root_cause_details: string;
    automatable: boolean;                   // tem ajuste programático sugerido?
  };

  // ─── Context (cross-ref com outros itens) ───
  context: {
    opportunity_id?: string;                // borrower address ou pair id
    venue?: string;                         // 'uniswapV3-500'
    relay_used?: string;                    // 'flashbots', 'public_mempool', etc
    bundle_hash?: string;                   // se backrun
    finality_status?: 'soft' | 'confirmed' | 'finalized' | 'orphaned';
    competitor_winner_sender?: string;
  };

  // ─── Payload pra dados não estruturados ───
  payload?: Record<string, unknown>;
}

/**
 * Stats agregados pra Discord daily digest.
 */
export interface ReconciliationStats {
  windowMs: number;
  totalReconciliations: number;
  expectedTotalUsd: number;
  realizedTotalUsd: number;
  netDeltaUsd: number;                       // realized - expected total
  avgDriftBps: number;                       // média ponderada
  attributionDistribution: Record<AttributionCause, number>;
  /** Reconciliations dentro da "banda normal" (±100bps drift). */
  withinNormalBandCount: number;
}

export function generateReconciliationId(timestamp: number): string {
  const tsHex = timestamp.toString(16).padStart(12, '0');
  const random = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `recon-${tsHex}-${random}`;
}
