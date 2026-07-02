/**
 * #9 automação — Calibração de gás (observe-first).
 *
 * O `GAS_COST_USD_ESTIMATE` do config é ESTÁTICO (ex.: $0.50). Na Base o gás real varia MUITO
 * (baseFee do bloco + L1 data fee). Se o estático estiver ALTO demais → rejeita trades bons; se
 * BAIXO demais → aceita trades que não pagam a inclusão. Este tracker observa o custo de gás
 * REAL/estimado ao vivo (janela rolante), compara com o estático e mostra "o que ajustaria".
 *
 * Funciona em DRY_RUN: a amostra é o custo estimado ao vivo (baseFee fresco × gas típico × ethUsd),
 * não precisa executar. Quando LIGADO (chave-mestra/flag), injeta o P95 observado no gate de EV.
 *
 * Regras da automação: piso/teto + histerese (não fica nervoso), observe-first, reversível.
 */

export interface GasCalibrationStats {
  samples: number;
  /** Custo de gás observado ao vivo — mediana (USD). */
  observedP50Usd: number;
  /** Custo de gás observado ao vivo — p95 (USD) — o valor conservador que injetaria. */
  observedP95Usd: number;
  /** O estático do config (baseline da comparação). */
  configuredUsd: number;
  /** (p95 − configurado) / configurado. Positivo = estático subestima; negativo = superestima. */
  driftPct: number;
  /** Valor que a calibração USARIA no gate (p95 observado), se ligada. */
  wouldAdjustToUsd: number;
  /** A calibração está de fato injetada no gate (true) ou só observando (false)? */
  applied: boolean;
}

interface Sample {
  usd: number;
  t: number;
}

const MIN_SAMPLES = 5; // histerese: não recalibra com pouca amostra
const DRIFT_ALERT = 0.25; // avisa quando o estático desvia >25% do real

export class GasCalibrationTracker {
  private samples: Sample[] = [];
  private readonly windowMs: number;
  private readonly configuredUsd: number;
  private readonly now: () => number;

  constructor(opts: { windowMs?: number; configuredUsd: number; now?: () => number }) {
    this.windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000; // 24h
    this.configuredUsd = opts.configuredUsd;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Registra uma amostra do custo de gás observado/estimado ao vivo (USD). */
  observe(gasCostUsd: number): void {
    if (!Number.isFinite(gasCostUsd) || gasCostUsd <= 0) return;
    const t = this.now();
    this.samples.push({ usd: gasCostUsd, t });
    this.prune(t);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    // Mantém só a janela; cap defensivo de memória.
    while (this.samples.length && this.samples[0]!.t < cutoff) this.samples.shift();
    if (this.samples.length > 5000) this.samples.splice(0, this.samples.length - 5000);
  }

  private percentile(p: number): number {
    if (!this.samples.length) return 0;
    const sorted = this.samples.map((s) => s.usd).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx]!;
  }

  /**
   * @param applied  a calibração está injetada no gate (chave-mestra/flag)? Só afeta o campo `applied`
   *                 e o valor efetivo que o gate deve usar — a decisão de injetar é do caller.
   */
  stats(applied: boolean): GasCalibrationStats {
    this.prune(this.now());
    const p50 = this.percentile(50);
    const p95 = this.percentile(95);
    const enoughData = this.samples.length >= MIN_SAMPLES;
    const wouldAdjustTo = enoughData ? p95 : this.configuredUsd;
    const driftPct = this.configuredUsd > 0 ? (p95 - this.configuredUsd) / this.configuredUsd : 0;
    return {
      samples: this.samples.length,
      observedP50Usd: p50,
      observedP95Usd: p95,
      configuredUsd: this.configuredUsd,
      driftPct: enoughData ? driftPct : 0,
      wouldAdjustToUsd: wouldAdjustTo,
      applied: applied && enoughData,
    };
  }

  /**
   * Valor de gás a USAR no gate: se ligado e com amostra suficiente, o p95 observado; senão, o estático.
   * Histerese embutida (MIN_SAMPLES) evita recalibrar no susto.
   */
  effectiveGasCostUsd(applied: boolean): number {
    const s = this.stats(applied);
    return s.applied ? s.observedP95Usd : this.configuredUsd;
  }

  /** True quando o estático está desalinhado o bastante pra valer um aviso no painel. */
  isDrifting(): boolean {
    const s = this.stats(false);
    return s.samples >= MIN_SAMPLES && Math.abs(s.driftPct) >= DRIFT_ALERT;
  }
}
