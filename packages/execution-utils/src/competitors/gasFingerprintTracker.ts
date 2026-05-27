/**
 * GasFingerprintTracker — Item 5 F3 do checklist.
 *
 * Sliding window REAL pra gas priorityFee por sender. Substitui running max
 * do senderRegistry inicial (que distorce p95/p99 ao longo do tempo).
 *
 * Estratégia:
 *  - Reservoir sampling: mantém últimas N=1000 amostras por sender (sliding window)
 *  - Pra p50/p95/p99: ordena window + interpolation linear
 *  - Memory bounded: 1000 amostras × ~8 bytes × N senders. Pra 100 senders = ~800KB
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export interface GasFingerprintTrackerOpts {
  /** Tamanho da sliding window por sender. Default 1000 amostras. */
  windowSize?: number;
  logger?: LoggerLike;
}

export interface GasFingerprint {
  samples: number;
  p50_priority_fee_gwei: number;
  p95_priority_fee_gwei: number;
  p99_priority_fee_gwei: number;
  avg_priority_fee_gwei: number;
  min_priority_fee_gwei: number;
  max_priority_fee_gwei: number;
}

const DEFAULT_WINDOW = 1000;

/**
 * Tracker dedicado pra gas fingerprint com sliding window real.
 * Pode ser usado standalone OU integrado ao SenderRegistry.
 */
export class GasFingerprintTracker {
  private readonly windowSize: number;
  private readonly logger: LoggerLike | undefined;
  private readonly windows = new Map<string, number[]>();

  constructor(opts: GasFingerprintTrackerOpts = {}) {
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW;
    this.logger = opts.logger;
  }

  /**
   * Adiciona amostra de gas priorityFee gwei pra sender.
   * Mantém apenas as últimas `windowSize` amostras (FIFO drop).
   */
  observe(sender: string, priorityFeeGwei: number): void {
    if (priorityFeeGwei <= 0 || !Number.isFinite(priorityFeeGwei)) return;
    const key = sender.toLowerCase();
    let window = this.windows.get(key);
    if (!window) {
      window = [];
      this.windows.set(key, window);
    }
    window.push(priorityFeeGwei);
    if (window.length > this.windowSize) {
      window.shift(); // FIFO drop
    }
  }

  /**
   * Calcula fingerprint completo (percentis + avg + min + max).
   * Retorna null se sender não tem amostras.
   */
  fingerprint(sender: string): GasFingerprint | null {
    const window = this.windows.get(sender.toLowerCase());
    if (!window || window.length === 0) return null;

    // Copy + sort pra cálculo de percentis
    const sorted = [...window].sort((a, b) => a - b);
    const n = sorted.length;

    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avg = sum / n;

    return {
      samples: n,
      p50_priority_fee_gwei: percentile(sorted, 0.5),
      p95_priority_fee_gwei: percentile(sorted, 0.95),
      p99_priority_fee_gwei: percentile(sorted, 0.99),
      avg_priority_fee_gwei: avg,
      min_priority_fee_gwei: sorted[0]!,
      max_priority_fee_gwei: sorted[n - 1]!,
    };
  }

  /**
   * Conta senders rastreados.
   */
  size(): number {
    return this.windows.size;
  }

  /**
   * Lista top N senders por p95 (mais agressivos em gas).
   */
  topByP95(limit = 10): Array<{ sender: string; p95: number; samples: number }> {
    const results: Array<{ sender: string; p95: number; samples: number }> = [];
    for (const [sender, window] of this.windows.entries()) {
      if (window.length < 5) continue; // mín pra significância
      const sorted = [...window].sort((a, b) => a - b);
      results.push({
        sender,
        p95: percentile(sorted, 0.95),
        samples: window.length,
      });
    }
    return results.sort((a, b) => b.p95 - a.p95).slice(0, limit);
  }

  /**
   * Snapshot pra persistência (Map → object).
   */
  snapshot(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [k, v] of this.windows.entries()) {
      out[k] = [...v];
    }
    return out;
  }

  /**
   * Restore from snapshot.
   */
  restore(snapshot: Record<string, number[]>): void {
    this.windows.clear();
    for (const k in snapshot) {
      this.windows.set(k, [...snapshot[k]!]);
    }
  }
}

/**
 * Calcula percentil via interpolation linear.
 * `sorted` deve estar ordenado crescente.
 * `p` em [0, 1].
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}
