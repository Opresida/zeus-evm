/**
 * LatencyTracker — buffer leve (ring buffer) de latências de dispatch (submit→confirmação, ms).
 *
 * Por quê: o histograma Prometheus `zeus_dispatch_duration_seconds` guarda só buckets — não dá pra
 * LER um percentil como número pro heartbeat. Aqui mantemos as N observações recentes em memória e
 * calculamos p50/p95 sob demanda (mesma fórmula de `senderRegistry.percentile`). Sem I/O, testável.
 *
 * Fica DORMENTE em DRY_RUN (não há dispatch real) → `samples === 0` → o heartbeat omite o bloco.
 */

/** Percentil (interpolação linear) de um array JÁ ORDENADO asc. q ∈ [0,1]. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface LatencyStats {
  /** Latência mediana (ms). */
  p50Ms: number;
  /** Latência p95 (ms). */
  p95Ms: number;
  /** Nº de amostras na janela. */
  samples: number;
}

export class LatencyTracker {
  private readonly buf: number[] = [];
  private readonly cap: number;

  constructor(cap = 500) {
    this.cap = Math.max(1, cap);
  }

  /** Registra uma latência de dispatch em ms (ignora valores inválidos). */
  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.buf.push(ms);
    if (this.buf.length > this.cap) this.buf.shift();
  }

  /** p50/p95 atuais + nº de amostras. p50/p95 = 0 quando não há amostra. */
  stats(): LatencyStats {
    const sorted = [...this.buf].sort((a, b) => a - b);
    return {
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
      samples: sorted.length,
    };
  }
}
