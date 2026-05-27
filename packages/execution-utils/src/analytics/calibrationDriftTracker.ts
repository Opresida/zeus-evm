/**
 * CalibrationDriftTracker — Item 4 A4 do checklist.
 *
 * Rolling 7d de drift `(realized - expected) / expected` em bps, agrupado por:
 *  - protocol (aave-v3, compound-v3, morpho-blue, backrun)
 *  - pair (USDC/WETH, WBTC/USDC, etc)
 *  - venue (uniswapV3-500, aerodrome-volatile, etc)
 *  - hour_utc (0-23)
 *
 * Detecta automaticamente drift sustentado >threshold em qualquer dimensão →
 * emite WARN com sugestão de ajuste (ex: trocar fee tier).
 *
 * Stateful in-memory. Snapshot opcional pra persistência.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export interface DriftSample {
  timestamp: number;
  protocol: string;
  pair?: string;
  venue?: string;
  hour_utc: number;
  drift_bps: number;
  realized_profit_usd: number;
}

export type DriftDimension = 'protocol' | 'pair' | 'venue' | 'hour_utc';

export interface DriftStats {
  key: string;             // valor da dimensão (ex: 'aave-v3', 'USDC/WETH')
  dimension: DriftDimension;
  samples: number;
  avg_drift_bps: number;
  median_drift_bps: number;
  total_realized_usd: number;
  /** True se drift médio < threshold sustentado (alerta sustentável). */
  is_sustained_drift: boolean;
  /** Sugestão de ação automatizável (texto curto). */
  suggested_action?: string;
}

export interface CalibrationDriftTrackerOpts {
  /** Janela rolling em ms. Default 7d. */
  windowMs?: number;
  /** Drift threshold pra considerar "sustained" (default -300bps). */
  sustainedDriftThresholdBps?: number;
  /** Mínimo de samples pra considerar significância. Default 10. */
  minSamplesForAlert?: number;
  logger?: LoggerLike;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLD = -300;
const DEFAULT_MIN_SAMPLES = 10;

export class CalibrationDriftTracker {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly minSamples: number;
  private readonly logger: LoggerLike | undefined;
  private samples: DriftSample[] = [];

  constructor(opts: CalibrationDriftTrackerOpts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.threshold = opts.sustainedDriftThresholdBps ?? DEFAULT_THRESHOLD;
    this.minSamples = opts.minSamplesForAlert ?? DEFAULT_MIN_SAMPLES;
    this.logger = opts.logger;
  }

  /**
   * Adiciona sample do PnlReconciler.
   */
  observe(sample: DriftSample): void {
    this.samples.push(sample);
    this._pruneOld();
  }

  /**
   * Stats por dimensão. Retorna lista ordenada por drift_bps ascendente
   * (pior primeiro pra ações prioritárias).
   */
  byDimension(dim: DriftDimension): DriftStats[] {
    this._pruneOld();

    const buckets = new Map<string, DriftSample[]>();
    for (const s of this.samples) {
      const key = this._keyForDim(s, dim);
      if (!key) continue;
      const list = buckets.get(key) ?? [];
      list.push(s);
      buckets.set(key, list);
    }

    const out: DriftStats[] = [];
    for (const [key, group] of buckets.entries()) {
      if (group.length === 0) continue;
      const drifts = group.map((g) => g.drift_bps).sort((a, b) => a - b);
      const avg = drifts.reduce((acc, v) => acc + v, 0) / drifts.length;
      const median = drifts.length % 2 === 1
        ? drifts[Math.floor(drifts.length / 2)]!
        : (drifts[drifts.length / 2 - 1]! + drifts[drifts.length / 2]!) / 2;
      const totalRealized = group.reduce((acc, g) => acc + g.realized_profit_usd, 0);
      const sustained = group.length >= this.minSamples && avg <= this.threshold;

      out.push({
        key,
        dimension: dim,
        samples: group.length,
        avg_drift_bps: Math.round(avg),
        median_drift_bps: Math.round(median),
        total_realized_usd: totalRealized,
        is_sustained_drift: sustained,
        suggested_action: sustained ? this._suggestAction(dim, key, avg) : undefined,
      });
    }

    return out.sort((a, b) => a.avg_drift_bps - b.avg_drift_bps);
  }

  /**
   * Top alerts: top N dimensões com drift sustentado.
   */
  topAlerts(limit = 5): DriftStats[] {
    const all: DriftStats[] = [];
    for (const dim of ['protocol', 'pair', 'venue', 'hour_utc'] as DriftDimension[]) {
      const stats = this.byDimension(dim).filter((s) => s.is_sustained_drift);
      all.push(...stats);
    }
    return all
      .sort((a, b) => a.avg_drift_bps - b.avg_drift_bps)
      .slice(0, limit);
  }

  /**
   * Stats agregados globais.
   */
  stats(): {
    total_samples: number;
    window_ms: number;
    avg_drift_bps_all: number;
    sustained_alerts_count: number;
  } {
    this._pruneOld();
    const drifts = this.samples.map((s) => s.drift_bps);
    const avg = drifts.length > 0
      ? drifts.reduce((acc, v) => acc + v, 0) / drifts.length
      : 0;
    return {
      total_samples: this.samples.length,
      window_ms: this.windowMs,
      avg_drift_bps_all: Math.round(avg),
      sustained_alerts_count: this.topAlerts(100).length,
    };
  }

  // ─── Internal ───

  private _keyForDim(s: DriftSample, dim: DriftDimension): string | null {
    switch (dim) {
      case 'protocol': return s.protocol;
      case 'pair': return s.pair ?? null;
      case 'venue': return s.venue ?? null;
      case 'hour_utc': return `${s.hour_utc}h`;
    }
  }

  private _pruneOld(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.samples.length > 0 && (this.samples[0]?.timestamp ?? 0) < cutoff) {
      this.samples.shift();
    }
  }

  private _suggestAction(dim: DriftDimension, key: string, avgDriftBps: number): string {
    const sign = avgDriftBps < 0 ? 'negativo' : 'positivo';
    switch (dim) {
      case 'protocol':
        return `Protocol ${key}: drift ${sign} sustentado ${avgDriftBps}bps. Revisar calculator pra esse protocolo.`;
      case 'pair':
        return `Par ${key}: drift sustentado ${avgDriftBps}bps. Considerar pausar par ou mudar venue.`;
      case 'venue':
        return `Venue ${key}: drift sustentado ${avgDriftBps}bps. Trocar pra venue alternativo ou fee tier diferente.`;
      case 'hour_utc':
        return `Horário ${key}: drift sustentado ${avgDriftBps}bps. Calibrar bribe maior nessa janela ou pausar.`;
    }
  }
}
