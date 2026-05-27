/**
 * ReorgAnalytics — Item 9 R7 do checklist.
 *
 * Rolling 30d de reorgs detectados, agrupado por:
 *  - hour_utc — quando reorgs concentram?
 *  - weekday — dia da semana
 *  - depth — distribuição de profundidade (1-block, 2-block, deep)
 *  - builder — qual proposer/miner mais associado
 *
 * Detecta padrões pra:
 *  - Identificar builders hostis (alta correlação com reorgs)
 *  - Calibrar confirmations required por horário (subir em horários ruins)
 *  - Pause preemptivo em windows de alto risco
 *
 * Stateful in-memory + snapshot opcional.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { ReorgEvent } from './finalityTracker';

export interface ReorgSample {
  detected_at: number;
  hour_utc: number;
  weekday: number;
  depth: number;
  /** Builder addresses dos blocos órfãos (lowercase). */
  orphaned_builders: string[];
  /** Builder addresses dos novos blocos (lowercase). */
  new_builders: string[];
}

export interface ReorgAggregateStats {
  total_reorgs: number;
  window_ms: number;
  avg_depth: number;
  max_depth: number;
  by_hour_utc: Record<number, number>;        // hour → count
  by_weekday: Record<number, number>;          // weekday → count
  by_depth: Record<number, number>;            // depth bucket → count
  by_orphan_builder: Array<{ builder: string; count: number }>;
  recent_reorgs: ReorgSample[];                // últimos 10
}

export interface ReorgAnalyticsOpts {
  /** Janela rolling. Default 30d. */
  windowMs?: number;
  logger?: LoggerLike;
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class ReorgAnalytics {
  private readonly windowMs: number;
  private readonly logger: LoggerLike | undefined;
  private samples: ReorgSample[] = [];

  constructor(opts: ReorgAnalyticsOpts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.logger = opts.logger;
  }

  /**
   * Handler do FinalityTracker.onReorg.
   * Registra sample com dimensões temporais + builders.
   */
  observe(event: ReorgEvent): void {
    const d = new Date(event.detectedAt);
    const sample: ReorgSample = {
      detected_at: event.detectedAt,
      hour_utc: d.getUTCHours(),
      weekday: d.getUTCDay(),
      depth: event.depth,
      orphaned_builders: event.orphanedBlocks
        .map((b) => b.miner?.toLowerCase())
        .filter((m): m is string => !!m),
      new_builders: event.newBlocks
        .map((b) => b.miner?.toLowerCase())
        .filter((m): m is string => !!m),
    };

    this.samples.push(sample);
    this._pruneOld();
  }

  /**
   * Stats agregados sobre samples rolling.
   */
  aggregate(): ReorgAggregateStats {
    this._pruneOld();

    const byHour: Record<number, number> = {};
    const byWeekday: Record<number, number> = {};
    const byDepth: Record<number, number> = {};
    const builderCounts = new Map<string, number>();
    let totalDepth = 0;
    let maxDepth = 0;

    for (const s of this.samples) {
      byHour[s.hour_utc] = (byHour[s.hour_utc] ?? 0) + 1;
      byWeekday[s.weekday] = (byWeekday[s.weekday] ?? 0) + 1;
      byDepth[s.depth] = (byDepth[s.depth] ?? 0) + 1;
      totalDepth += s.depth;
      if (s.depth > maxDepth) maxDepth = s.depth;
      // Builders dos blocos órfãos (potencialmente "hostis")
      for (const b of s.orphaned_builders) {
        builderCounts.set(b, (builderCounts.get(b) ?? 0) + 1);
      }
    }

    const byBuilder = [...builderCounts.entries()]
      .map(([builder, count]) => ({ builder, count }))
      .sort((a, b) => b.count - a.count);

    return {
      total_reorgs: this.samples.length,
      window_ms: this.windowMs,
      avg_depth: this.samples.length > 0 ? Math.round((totalDepth / this.samples.length) * 100) / 100 : 0,
      max_depth: maxDepth,
      by_hour_utc: byHour,
      by_weekday: byWeekday,
      by_depth: byDepth,
      by_orphan_builder: byBuilder,
      recent_reorgs: this.samples.slice(-10),
    };
  }

  /**
   * Top builders associados a blocos órfãos (potencialmente hostis).
   */
  topHostileBuilders(limit = 5): Array<{ builder: string; orphans: number }> {
    return this.aggregate()
      .by_orphan_builder
      .slice(0, limit)
      .map((b) => ({ builder: b.builder, orphans: b.count }));
  }

  /**
   * Hours UTC com maior concentração de reorgs (potencialmente "perigosas").
   */
  highRiskHours(thresholdMultiplier = 2): number[] {
    const stats = this.aggregate();
    if (stats.total_reorgs === 0) return [];

    const avgPerHour = stats.total_reorgs / 24;
    const threshold = avgPerHour * thresholdMultiplier;

    return Object.entries(stats.by_hour_utc)
      .filter(([_, count]) => count >= threshold)
      .map(([hour]) => parseInt(hour, 10))
      .sort((a, b) => a - b);
  }

  /**
   * Snapshot pra persistência.
   */
  snapshot(): ReorgSample[] {
    return [...this.samples];
  }

  /**
   * Restore from snapshot.
   */
  restore(samples: ReorgSample[]): void {
    this.samples = [...samples];
    this._pruneOld();
  }

  // ─── Internal ───

  private _pruneOld(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.samples.length > 0 && (this.samples[0]?.detected_at ?? 0) < cutoff) {
      this.samples.shift();
    }
  }
}
