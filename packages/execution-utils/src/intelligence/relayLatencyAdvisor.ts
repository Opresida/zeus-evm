/**
 * #14 automação — Latência de relay/dispatch (observe-first).
 *
 * Reusa a latência p50/p95 que o bot já mede (`LatencyTracker`). Guarda uma BASELINE (o melhor p95 visto,
 * com histerese) e avisa quando a latência ATUAL degrada além de um fator (ex.: p95 > 2× a baseline) — sinal
 * de relay/RPC lento. Sem inventar sinal: recebe o p95 já computado. Só observa/avisa.
 *
 * Em DRY_RUN não há dispatch → sem amostra → estado "sem dados" (honesto). Ganha valor ao vivo/mainnet.
 */

export interface RelayLatencyStatus {
  samples: number;
  currentP95Ms: number;
  baselineP95Ms: number;
  /** currentP95 / baselineP95 (1 = igual à baseline). */
  ratio: number;
  degraded: boolean;
  summary: string;
}

const DEGRADE_FACTOR = 2; // avisa quando p95 atual ≥ 2× a baseline

export class RelayLatencyAdvisor {
  private baselineP95Ms = 0;
  private readonly factor: number;

  constructor(opts?: { degradeFactor?: number }) {
    this.factor = opts?.degradeFactor ?? DEGRADE_FACTOR;
  }

  /**
   * @param p95Ms   latência p95 atual (do LatencyTracker).
   * @param samples nº de amostras (0 = sem dados → não avalia).
   */
  status(p95Ms: number, samples: number): RelayLatencyStatus {
    if (samples <= 0 || !Number.isFinite(p95Ms) || p95Ms <= 0) {
      return { samples, currentP95Ms: 0, baselineP95Ms: this.baselineP95Ms, ratio: 1, degraded: false, summary: 'sem amostra de dispatch' };
    }
    // Baseline = melhor (menor) p95 visto com amostra suficiente (histerese: só desce a baseline).
    if (this.baselineP95Ms === 0 || (samples >= 10 && p95Ms < this.baselineP95Ms)) {
      this.baselineP95Ms = p95Ms;
    }
    const ratio = this.baselineP95Ms > 0 ? p95Ms / this.baselineP95Ms : 1;
    const degraded = samples >= 10 && ratio >= this.factor;
    const summary = degraded
      ? `latência ${p95Ms}ms = ${ratio.toFixed(1)}× a baseline (${this.baselineP95Ms}ms) — relay/RPC lento`
      : `latência ${p95Ms}ms (baseline ${this.baselineP95Ms}ms) — ok`;
    return { samples, currentP95Ms: p95Ms, baselineP95Ms: this.baselineP95Ms, ratio, degraded, summary };
  }
}
