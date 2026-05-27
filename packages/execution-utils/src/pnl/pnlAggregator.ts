/**
 * PnlAggregator — Item 10 P6 do checklist.
 *
 * Rolling aggregations 7d/30d/90d sobre PnlReconciliations por múltiplas dimensões:
 *  - protocol (aave-v3, compound-v3, morpho-blue, backrun, arb)
 *  - venue (uniswapV3-500, aerodrome-volatile)
 *  - pair (USDC/WETH, WBTC/USDC, etc — via opportunity_id ou venue cross-ref)
 *  - hour_utc + weekday
 *  - relay_used
 *
 * Alimenta IA futura (Item 16A) com features prontas pra training.
 * Também serve Discord weekly digest + Markdown weekly deep dive.
 *
 * Filosofia: rolling window in-memory. Snapshot opcional pra persistência longa
 * (depois swap pra DuckDB query se necessário).
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { PnlReconciliation } from './pnlSchema';

export type WindowName = '24h' | '7d' | '30d' | '90d';

export const WINDOW_MS: Record<WindowName, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

export type AggregationDimension = 'protocol' | 'venue' | 'pair' | 'hour_utc' | 'weekday' | 'relay_used';

export interface AggregationResult {
  key: string;
  dimension: AggregationDimension;
  window: WindowName;
  samples: number;
  total_expected_usd: number;
  total_realized_usd: number;
  total_net_usd: number;
  net_delta_usd: number;
  avg_drift_bps: number;
  median_drift_bps: number;
  win_rate: number;                  // 0-1
  wins: number;
  losses: number;
  /** Avg slippage real (em bps) — só se houve swap output decoded. */
  avg_slippage_real_bps?: number;
}

export interface PnlAggregatorOpts {
  /** Cap de samples em memória (FIFO drop). Default 10k. */
  maxSamples?: number;
  logger?: LoggerLike;
}

const DEFAULT_MAX_SAMPLES = 10_000;

export class PnlAggregator {
  private readonly maxSamples: number;
  private readonly logger: LoggerLike | undefined;
  private samples: PnlReconciliation[] = [];

  constructor(opts: PnlAggregatorOpts = {}) {
    this.maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
    this.logger = opts.logger;
  }

  /**
   * Adiciona reconciliation pra agregação. Drop oldest se passar maxSamples.
   * Chamar isto após PnlReconciler.reconcile() (caller hook).
   */
  observe(recon: PnlReconciliation): void {
    this.samples.push(recon);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * Agrega por dimensão + window. Retorna lista ordenada por net_delta_usd asc
   * (pior primeiro = ação prioritária).
   */
  aggregate(dim: AggregationDimension, window: WindowName): AggregationResult[] {
    const cutoff = Date.now() - WINDOW_MS[window];
    const inWindow = this.samples.filter((s) => s.timestamp >= cutoff);

    const buckets = new Map<string, PnlReconciliation[]>();
    for (const s of inWindow) {
      const key = this._keyForDim(s, dim);
      if (!key) continue;
      const list = buckets.get(key) ?? [];
      list.push(s);
      buckets.set(key, list);
    }

    const out: AggregationResult[] = [];
    for (const [key, group] of buckets.entries()) {
      if (group.length === 0) continue;
      const drifts = group.map((g) => g.deltas.profit_delta_bps).sort((a, b) => a - b);
      const avgDrift = drifts.reduce((acc, v) => acc + v, 0) / drifts.length;
      const medDrift = drifts.length % 2 === 1
        ? drifts[Math.floor(drifts.length / 2)]!
        : (drifts[drifts.length / 2 - 1]! + drifts[drifts.length / 2]!) / 2;

      const totalExpected = group.reduce((acc, g) => acc + g.expected.profit_usd, 0);
      const totalRealized = group.reduce((acc, g) => acc + g.realized.profit_usd, 0);
      const totalNet = group.reduce((acc, g) => acc + g.realized.net_profit_usd, 0);
      const wins = group.filter((g) => g.realized.net_profit_usd > 0).length;
      const losses = group.length - wins;

      // Slippage avg só pra ops com swap output decoded
      const withSlip = group.filter((g) => g.realized.slippage_bps !== undefined);
      const avgSlip = withSlip.length > 0
        ? Math.round(withSlip.reduce((acc, g) => acc + (g.realized.slippage_bps ?? 0), 0) / withSlip.length)
        : undefined;

      out.push({
        key,
        dimension: dim,
        window,
        samples: group.length,
        total_expected_usd: totalExpected,
        total_realized_usd: totalRealized,
        total_net_usd: totalNet,
        net_delta_usd: totalRealized - totalExpected,
        avg_drift_bps: Math.round(avgDrift),
        median_drift_bps: Math.round(medDrift),
        win_rate: wins / group.length,
        wins,
        losses,
        avg_slippage_real_bps: avgSlip,
      });
    }

    return out.sort((a, b) => a.net_delta_usd - b.net_delta_usd);
  }

  /**
   * Top N "best performers" por win rate * samples (pra weighting).
   */
  topPerformers(dim: AggregationDimension, window: WindowName, limit = 5): AggregationResult[] {
    return this.aggregate(dim, window)
      .filter((r) => r.samples >= 3) // min pra significância
      .sort((a, b) => b.win_rate * b.samples - a.win_rate * a.samples)
      .slice(0, limit);
  }

  /**
   * Top N "worst performers" por net_delta_usd negativo (perdas).
   */
  worstPerformers(dim: AggregationDimension, window: WindowName, limit = 5): AggregationResult[] {
    return this.aggregate(dim, window)
      .filter((r) => r.samples >= 3 && r.net_delta_usd < 0)
      .slice(0, limit);
  }

  /**
   * Multi-dimensional summary: top performers por TODAS dimensões.
   * Pra Discord weekly digest.
   */
  weeklySummary(): {
    by_protocol: AggregationResult[];
    by_venue: AggregationResult[];
    by_pair: AggregationResult[];
    by_hour_utc: AggregationResult[];
    worst_overall: AggregationResult[];
  } {
    return {
      by_protocol: this.aggregate('protocol', '7d').slice(0, 5),
      by_venue: this.aggregate('venue', '7d').slice(0, 5),
      by_pair: this.aggregate('pair', '7d').slice(0, 5),
      by_hour_utc: this.aggregate('hour_utc', '7d').slice(0, 8),
      worst_overall: this.worstPerformers('protocol', '7d', 5),
    };
  }

  /**
   * Stats globais.
   */
  stats(): { total_samples: number; oldest_at: number | null; newest_at: number | null } {
    if (this.samples.length === 0) {
      return { total_samples: 0, oldest_at: null, newest_at: null };
    }
    return {
      total_samples: this.samples.length,
      oldest_at: this.samples[0]?.timestamp ?? null,
      newest_at: this.samples[this.samples.length - 1]?.timestamp ?? null,
    };
  }

  // ─── Internal ───

  private _keyForDim(s: PnlReconciliation, dim: AggregationDimension): string | null {
    switch (dim) {
      case 'protocol': return s.protocol;
      case 'venue': return s.context.venue ?? null;
      case 'pair': return s.context.opportunity_id ?? null; // proxy se não temos pair direto
      case 'hour_utc': {
        const d = new Date(s.timestamp);
        return `${d.getUTCHours()}h`;
      }
      case 'weekday': {
        const d = new Date(s.timestamp);
        const wd = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][d.getUTCDay()];
        return wd ?? null;
      }
      case 'relay_used': return s.context.relay_used ?? null;
    }
  }
}
