/**
 * #10 (throttle de varredura) + #11 (revet dinâmico) — advisor de intervalo adaptativo (observe-first).
 *
 * Recomenda um INTERVALO (ms) entre o mínimo (rápido, quando há atividade/urgência) e o máximo (lento,
 * quando parado — economiza RPC). Recebe um "nível de atividade" 0..1 que o caller computa do dado que o
 * bot já mede (ex.: #10 = houve oportunidade recente? RPC saudável?; #11 = churn de tokens no universo?).
 *
 * Histerese: só troca a recomendação se o delta for relevante (evita ficar nervoso). Observe-first: o caller
 * decide se APLICA (reprograma o timer) ou só mostra "reduziria pra Xs". Sem inventar sinal.
 */

export interface IntervalRecommendation {
  currentMs: number;
  recommendedMs: number;
  /** Motivo em PT-BR curto pro painel. */
  reason: string;
  /** A recomendação está sendo APLICADA (timer reprogramado) ou só observando? */
  applied: boolean;
}

export class AdaptiveIntervalAdvisor {
  private readonly baseMs: number;
  private readonly minMs: number;
  private readonly maxMs: number;
  private lastRecommendedMs: number;

  constructor(opts: { baseMs: number; minMs?: number; maxMs?: number }) {
    this.baseMs = opts.baseMs;
    this.minMs = opts.minMs ?? opts.baseMs;
    this.maxMs = opts.maxMs ?? opts.baseMs * 6;
    this.lastRecommendedMs = opts.baseMs;
  }

  /**
   * @param activity  0..1 — 1 = muita atividade/urgência (rápido, minMs); 0 = parado (lento, maxMs).
   * @param reason    motivo em PT-BR pro painel.
   */
  recommend(activity: number, reason: string): IntervalRecommendation {
    const a = Math.max(0, Math.min(1, Number.isFinite(activity) ? activity : 0.5));
    // Interpola: atividade alta → minMs; baixa → maxMs. Ancorado no base como piso da "atividade média".
    const target = a >= 0.5
      ? this.minMs + (this.baseMs - this.minMs) * (1 - (a - 0.5) / 0.5)
      : this.baseMs + (this.maxMs - this.baseMs) * ((0.5 - a) / 0.5);
    const targetMs = Math.round(Math.max(this.minMs, Math.min(this.maxMs, target)));
    // Histerese: mantém o anterior se a mudança for <15% (não fica nervoso).
    const changed = Math.abs(targetMs - this.lastRecommendedMs) / this.lastRecommendedMs >= 0.15;
    if (changed) this.lastRecommendedMs = targetMs;
    return {
      currentMs: this.baseMs,
      recommendedMs: this.lastRecommendedMs,
      reason,
      applied: false, // o caller sobrescreve quando reprograma o timer de verdade
    };
  }

  get recommendedMs(): number {
    return this.lastRecommendedMs;
  }
}
