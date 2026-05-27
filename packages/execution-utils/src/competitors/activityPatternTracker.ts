/**
 * ActivityPatternTracker — Item 5 F4 do checklist.
 *
 * Tracking refinado de padrões temporais por sender:
 *  - txs/hora distribuídos em 24 buckets (UTC)
 *  - txs/dia da semana (7 buckets)
 *  - Peak hour detection (hora UTC com >threshold% das txs)
 *  - Active range (primeiro/último visto)
 *  - Burst detection (>N txs em janela curta = burst window)
 *
 * Substitui activity field básico do senderRegistry inicial.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export interface ActivityPatternOpts {
  /** Tamanho de buckets temporais. Default 24 (hourly). */
  hourBuckets?: number;
  /** % mínima de txs pra considerar "active hour". Default 0.05 (5%). */
  activeHourThreshold?: number;
  /** Janela em ms pra burst detection. Default 60s. */
  burstWindowMs?: number;
  /** N+ txs em burstWindow = burst. Default 5. */
  burstMinCount?: number;
  logger?: LoggerLike;
}

interface SenderActivity {
  first_seen_at: number;
  last_seen_at: number;
  total_txs: number;
  hour_counts: number[];          // 24 buckets
  weekday_counts: number[];       // 7 buckets
  recent_timestamps: number[];    // últimos 1000 timestamps pra burst detection
  bursts_detected: number;
}

export interface ActivityPattern {
  total_txs: number;
  active_hours_utc: number[];     // horas com >threshold txs
  peak_hour_utc: number;
  peak_hour_txs: number;
  weekday_distribution: number[]; // [seg, ter, qua, qui, sex, sab, dom]
  active_range_ms: number;        // last - first
  txs_per_active_hour: number;    // média entre active hours
  bursts_detected: number;
  longest_silence_ms: number;     // maior gap entre txs consecutivas
}

const DEFAULT_THRESHOLD = 0.05;
const DEFAULT_BURST_WINDOW_MS = 60_000;
const DEFAULT_BURST_MIN = 5;
const RECENT_TIMESTAMPS_CAP = 1000;

export class ActivityPatternTracker {
  private readonly threshold: number;
  private readonly burstWindowMs: number;
  private readonly burstMin: number;
  private readonly logger: LoggerLike | undefined;
  private readonly senders = new Map<string, SenderActivity>();

  constructor(opts: ActivityPatternOpts = {}) {
    this.threshold = opts.activeHourThreshold ?? DEFAULT_THRESHOLD;
    this.burstWindowMs = opts.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;
    this.burstMin = opts.burstMinCount ?? DEFAULT_BURST_MIN;
    this.logger = opts.logger;
  }

  /**
   * Registra observação de tx pra sender no timestamp dado.
   */
  observe(sender: string, timestamp: number): void {
    const key = sender.toLowerCase();
    const d = new Date(timestamp);
    const hour = d.getUTCHours();
    const weekday = d.getUTCDay();

    let activity = this.senders.get(key);
    if (!activity) {
      activity = {
        first_seen_at: timestamp,
        last_seen_at: timestamp,
        total_txs: 0,
        hour_counts: new Array(24).fill(0),
        weekday_counts: new Array(7).fill(0),
        recent_timestamps: [],
        bursts_detected: 0,
      };
      this.senders.set(key, activity);
    }

    activity.last_seen_at = Math.max(activity.last_seen_at, timestamp);
    activity.total_txs++;
    activity.hour_counts[hour]++;
    activity.weekday_counts[weekday]++;
    activity.recent_timestamps.push(timestamp);
    if (activity.recent_timestamps.length > RECENT_TIMESTAMPS_CAP) {
      activity.recent_timestamps.shift();
    }

    // Burst detection: olha últimas N timestamps, se cobrem < burstWindowMs = burst
    if (activity.recent_timestamps.length >= this.burstMin) {
      const recent = activity.recent_timestamps.slice(-this.burstMin);
      const span = recent[recent.length - 1]! - recent[0]!;
      if (span <= this.burstWindowMs) {
        activity.bursts_detected++;
      }
    }
  }

  /**
   * Retorna pattern analítico de um sender, ou null se não rastreado.
   */
  pattern(sender: string): ActivityPattern | null {
    const a = this.senders.get(sender.toLowerCase());
    if (!a || a.total_txs === 0) return null;

    // Active hours: horas com >threshold% das txs totais
    const minCount = a.total_txs * this.threshold;
    const active_hours_utc: number[] = [];
    let peak_hour_utc = 0;
    let peak_hour_txs = 0;
    for (let i = 0; i < 24; i++) {
      const c = a.hour_counts[i] ?? 0;
      if (c >= minCount) active_hours_utc.push(i);
      if (c > peak_hour_txs) {
        peak_hour_txs = c;
        peak_hour_utc = i;
      }
    }

    // longest_silence: maior gap entre recent_timestamps consecutivos
    let longest_silence_ms = 0;
    for (let i = 1; i < a.recent_timestamps.length; i++) {
      const gap = a.recent_timestamps[i]! - a.recent_timestamps[i - 1]!;
      if (gap > longest_silence_ms) longest_silence_ms = gap;
    }

    const txs_per_active_hour = active_hours_utc.length > 0
      ? a.total_txs / active_hours_utc.length
      : 0;

    return {
      total_txs: a.total_txs,
      active_hours_utc,
      peak_hour_utc,
      peak_hour_txs,
      weekday_distribution: [...a.weekday_counts],
      active_range_ms: a.last_seen_at - a.first_seen_at,
      txs_per_active_hour,
      bursts_detected: a.bursts_detected,
      longest_silence_ms,
    };
  }

  /**
   * Lista senders ordenados por bursts detectados (mais "explosivos" primeiro).
   */
  topByBursts(limit = 10): Array<{ sender: string; bursts: number; total: number }> {
    const out: Array<{ sender: string; bursts: number; total: number }> = [];
    for (const [sender, a] of this.senders.entries()) {
      if (a.bursts_detected === 0) continue;
      out.push({ sender, bursts: a.bursts_detected, total: a.total_txs });
    }
    return out.sort((a, b) => b.bursts - a.bursts).slice(0, limit);
  }

  size(): number {
    return this.senders.size;
  }
}
