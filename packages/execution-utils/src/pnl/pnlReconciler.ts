/**
 * PnlReconciler — Item 10 P1 (hub central que monta a reconciliation).
 *
 * Recebe inputs heterogêneos (decision do calculator, receipt, decoded events)
 * e produz `PnlReconciliation` rica + attribution.
 *
 * Persistência: JSONL append-only (rolling diário). Mesma estratégia do
 * failureCollector pra retention diferenciada.
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type {
  PnlReconciliation,
  ReconciliationStats,
  AttributionCause,
} from './pnlSchema';
import { generateReconciliationId } from './pnlSchema';
import { attribute, suggestAction, type AttributionInput } from './attributionAnalyzer';

export interface PnlReconcilerOpts {
  baseDir?: string;
  /** Window em ms pra stats rolling. Default 24h. */
  windowMs?: number;
  /**
   * Observers chamados após cada reconcile (fan-out desacoplado). Usado pra alimentar
   * PnlAggregator + CalibrationDriftTracker sem o reconciler conhecer esses tipos.
   * Erro num observer NUNCA quebra o reconcile (try/catch interno).
   */
  onReconcile?: (recon: PnlReconciliation) => void;
  logger?: LoggerLike;
}

export interface ReconcileInput {
  chain: string;
  protocol: PnlReconciliation['protocol'];
  tx_hash: string;
  block_number: bigint;
  timestamp?: number;

  // Expected (do calculator)
  expected_profit_wei: bigint;
  expected_profit_usd: number;
  flashloan_amount_wei?: bigint;
  expected_swap_output_wei?: bigint;
  expected_slippage_bps?: number;
  expected_gas_units?: bigint;
  expected_gas_usd?: number;
  expected_bribe_bps?: number;
  expected_min_bribe_wei?: bigint;

  // Realized (do receipt)
  realized_profit_wei: bigint;
  realized_profit_usd: number;
  realized_gas_units_used: bigint;
  realized_gas_usd: number;
  realized_priority_fee_wei?: bigint;
  realized_base_fee_wei?: bigint;
  eth_usd_price?: number;

  // Decoded events (opcional — se passou pelos trackers)
  realized_swap_output_wei?: bigint;
  realized_bribe_wei_paid?: bigint;
  realized_bribe_usd_paid?: number;

  // Context
  opportunity_id?: string;
  venue?: string;
  relay_used?: string;
  bundle_hash?: string;
  finality_status?: 'soft' | 'confirmed' | 'finalized' | 'orphaned';
  competitor_winner_sender?: string;
}

const DEFAULT_BASE_DIR = 'logs/pnl-reconciliations';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const ALL_CAUSES: AttributionCause[] = [
  'within_normal_band', 'pool_slippage', 'gas_spike', 'bribe_overshoot',
  'frontrun_loss', 'oracle_drift', 'reorg_recovery_cost', 'unknown',
];

export class PnlReconciler {
  private readonly baseDir: string;
  private readonly windowMs: number;
  private readonly logger: LoggerLike | undefined;
  private readonly onReconcile: ((recon: PnlReconciliation) => void) | undefined;
  private rolling: PnlReconciliation[] = [];
  /** Gás USD acumulado em TODA a vida do processo (pra gauge zeus_gas_usd_paid_total). */
  private cumulativeGasUsd = 0;

  constructor(opts: PnlReconcilerOpts = {}) {
    this.baseDir = opts.baseDir ?? DEFAULT_BASE_DIR;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.logger = opts.logger;
    this.onReconcile = opts.onReconcile;
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Constrói reconciliation completa (com attribution) a partir do input.
   * Persiste JSONL + atualiza rolling window.
   */
  reconcile(input: ReconcileInput): PnlReconciliation {
    const timestamp = input.timestamp ?? Date.now();
    const id = generateReconciliationId(timestamp);

    // ─── Calcula slippage real se temos swap output ───
    let realizedSlippageBps: number | undefined;
    let slippageDeltaBps: number | undefined;
    if (
      input.expected_swap_output_wei !== undefined &&
      input.expected_swap_output_wei > 0n &&
      input.realized_swap_output_wei !== undefined
    ) {
      // slippage = (expected - real) / expected * 10000
      if (input.realized_swap_output_wei < input.expected_swap_output_wei) {
        const delta = input.expected_swap_output_wei - input.realized_swap_output_wei;
        realizedSlippageBps = Number((delta * 10_000n) / input.expected_swap_output_wei);
      } else {
        realizedSlippageBps = 0;
      }
      if (input.expected_slippage_bps !== undefined) {
        slippageDeltaBps = realizedSlippageBps - input.expected_slippage_bps;
      }
    }

    // ─── Deltas ───
    const profitDeltaUsd = input.realized_profit_usd - input.expected_profit_usd;
    const profitDeltaBps = input.expected_profit_usd > 0
      ? Math.round((profitDeltaUsd / input.expected_profit_usd) * 10_000)
      : 0;
    const gasDeltaUsd = input.realized_gas_usd - (input.expected_gas_usd ?? 0);
    const bribeDeltaUsd = input.realized_bribe_usd_paid !== undefined
      ? input.realized_bribe_usd_paid // expected_bribe não modelado em USD aqui
      : undefined;

    // ─── Net profit (expected + realized) ───
    const expectedNetUsd = input.expected_profit_usd
      - (input.expected_gas_usd ?? 0);
    const realizedNetUsd = input.realized_profit_usd
      - input.realized_gas_usd
      - (input.realized_bribe_usd_paid ?? 0);
    const netDeltaUsd = realizedNetUsd - expectedNetUsd;

    // ─── Inclusion cost breakdown ───
    const ethUsd = input.eth_usd_price ?? 3500;
    const priorityFeeUsd = input.realized_priority_fee_wei !== undefined
      ? (Number(input.realized_priority_fee_wei * input.realized_gas_units_used) / 1e18) * ethUsd
      : undefined;
    const baseFeeUsd = input.realized_base_fee_wei !== undefined
      ? (Number(input.realized_base_fee_wei * input.realized_gas_units_used) / 1e18) * ethUsd
      : undefined;
    const totalInclusionUsd = (priorityFeeUsd ?? 0) + (input.realized_bribe_usd_paid ?? 0);
    const inclusionAsPercentOfProfit = input.realized_profit_usd > 0
      ? totalInclusionUsd / input.realized_profit_usd
      : 0;

    // ─── Construção do schema ───
    const recon: PnlReconciliation = {
      id,
      timestamp,
      chain: input.chain,
      protocol: input.protocol,
      tx_hash: input.tx_hash,
      block_number: input.block_number,
      expected: {
        profit_wei: input.expected_profit_wei,
        profit_usd: input.expected_profit_usd,
        flashloan_amount_wei: input.flashloan_amount_wei,
        swap_output_wei: input.expected_swap_output_wei,
        slippage_bps: input.expected_slippage_bps,
        gas_units_estimated: input.expected_gas_units,
        gas_usd_estimated: input.expected_gas_usd,
        bribe_bps: input.expected_bribe_bps,
        min_bribe_wei: input.expected_min_bribe_wei,
        net_profit_usd_estimated: expectedNetUsd,
      },
      realized: {
        profit_wei: input.realized_profit_wei,
        profit_usd: input.realized_profit_usd,
        swap_output_wei: input.realized_swap_output_wei,
        slippage_bps: realizedSlippageBps,
        gas_units_used: input.realized_gas_units_used,
        gas_usd_actual: input.realized_gas_usd,
        bribe_wei_paid: input.realized_bribe_wei_paid,
        bribe_usd_paid: input.realized_bribe_usd_paid,
        net_profit_usd: realizedNetUsd,
      },
      deltas: {
        profit_delta_bps: profitDeltaBps,
        profit_delta_usd: profitDeltaUsd,
        slippage_delta_bps: slippageDeltaBps,
        gas_delta_usd: gasDeltaUsd,
        bribe_delta_usd: bribeDeltaUsd,
        net_delta_usd: netDeltaUsd,
      },
      inclusion_cost: {
        priority_fee_wei_paid: input.realized_priority_fee_wei,
        priority_fee_usd_paid: priorityFeeUsd,
        base_fee_wei_paid: input.realized_base_fee_wei,
        base_fee_usd_paid: baseFeeUsd,
        bribe_coinbase_usd_paid: input.realized_bribe_usd_paid,
        total_inclusion_usd: totalInclusionUsd,
        inclusion_as_percent_of_profit: inclusionAsPercentOfProfit,
      },
      attribution: {
        primary_cause: 'within_normal_band',
        confidence: 1,
        root_cause_details: '',
        automatable: false,
      },
      context: {
        opportunity_id: input.opportunity_id,
        venue: input.venue,
        relay_used: input.relay_used,
        bundle_hash: input.bundle_hash,
        finality_status: input.finality_status,
        competitor_winner_sender: input.competitor_winner_sender,
      },
    };

    // ─── Roda attribution ───
    const attr = attribute({
      expected: recon.expected,
      realized: recon.realized,
      deltas: recon.deltas,
      inclusion_cost: recon.inclusion_cost,
      context: recon.context,
    } as AttributionInput);
    recon.attribution = attr;

    // ─── Persiste JSONL + rolling window ───
    this._persist(recon);
    this.rolling.push(recon);
    this.cumulativeGasUsd += input.realized_gas_usd;
    this._pruneOldEntries();

    // ─── Log informativo + sugestão ───
    const suggestion = suggestAction(attr, recon);
    this.logger?.info(
      {
        recon_id: id,
        tx_hash: input.tx_hash,
        protocol: input.protocol,
        profit_delta_bps: profitDeltaBps,
        net_delta_usd: netDeltaUsd.toFixed(4),
        primary_cause: attr.primary_cause,
        confidence: attr.confidence,
        suggestion,
      },
      `📊 reconciliation ${id} | cause=${attr.primary_cause} delta=${profitDeltaBps}bps`,
    );

    // Fan-out desacoplado (PnlAggregator + CalibrationDriftTracker). Nunca quebra o reconcile.
    if (this.onReconcile) {
      try {
        this.onReconcile(recon);
      } catch (err) {
        this.logger?.warn({ err: err instanceof Error ? err.message : err }, 'onReconcile observer falhou (ignorado)');
      }
    }

    return recon;
  }

  /** Gás USD total pago desde o boot (cumulativo, pra gauge Prometheus). */
  cumulativeGasUsdPaid(): number {
    return this.cumulativeGasUsd;
  }

  /**
   * Stats rolling 24h.
   */
  stats(): ReconciliationStats {
    this._pruneOldEntries();

    let expectedTotal = 0;
    let realizedTotal = 0;
    let weightedDriftBpsSum = 0;
    let weightTotal = 0;
    let withinBand = 0;
    const dist: Record<AttributionCause, number> = {} as Record<AttributionCause, number>;
    for (const c of ALL_CAUSES) dist[c] = 0;

    for (const r of this.rolling) {
      expectedTotal += r.expected.profit_usd;
      realizedTotal += r.realized.profit_usd;
      // weight = expected USD (priorize ops grandes na drift)
      const w = Math.max(0.01, r.expected.profit_usd);
      weightedDriftBpsSum += r.deltas.profit_delta_bps * w;
      weightTotal += w;
      if (r.attribution.primary_cause === 'within_normal_band') withinBand++;
      dist[r.attribution.primary_cause] = (dist[r.attribution.primary_cause] ?? 0) + 1;
    }

    return {
      windowMs: this.windowMs,
      totalReconciliations: this.rolling.length,
      expectedTotalUsd: expectedTotal,
      realizedTotalUsd: realizedTotal,
      netDeltaUsd: realizedTotal - expectedTotal,
      avgDriftBps: weightTotal > 0 ? Math.round(weightedDriftBpsSum / weightTotal) : 0,
      attributionDistribution: dist,
      withinNormalBandCount: withinBand,
    };
  }

  /**
   * Lista reconciliations recentes pra debug.
   */
  recent(limit = 20): PnlReconciliation[] {
    return this.rolling.slice(-limit);
  }

  // ─── Internal ───

  private _persist(recon: PnlReconciliation): void {
    try {
      const d = new Date(recon.timestamp);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const filePath = join(this.baseDir, `${yyyy}-${mm}-${dd}.jsonl`);

      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // BigInt serialization
      const json = JSON.stringify(recon, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      appendFileSync(filePath, json + '\n', { encoding: 'utf-8' });
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err, reconId: recon.id },
        'PnlReconciler: erro persistindo (drop silencioso)',
      );
    }
  }

  private _pruneOldEntries(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.rolling.length > 0 && (this.rolling[0]?.timestamp ?? 0) < cutoff) {
      this.rolling.shift();
    }
  }
}
