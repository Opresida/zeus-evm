/**
 * #13 automação — Saúde do flashloan (observe-first).
 *
 * O bot escolhe a fonte de flashloan por liquidez: Morpho 0% → Balancer 0% → Aave 0,05% (fallback PAGO).
 * Este tracker registra qual fonte foi escolhida a cada seleção (janela rolante) e mostra a distribuição +
 * "quanto está caindo no fallback pago" — sinal de que as fontes 0% estão sem liquidez pro tamanho pedido.
 * Roda em DRY_RUN (a seleção é um probe read, não precisa executar). Só observa/avisa.
 */

export type FlashSourceKey = 'morpho' | 'balancer' | 'aave' | string;

export interface FlashHealthStats {
  samples: number;
  morphoPct: number;
  balancerPct: number;
  aavePct: number; // fallback PAGO (0,05%)
  freeSharePct: number; // morpho + balancer (0%)
  /** True quando o fallback pago passou do teto (fontes 0% indisponíveis com frequência). */
  degraded: boolean;
  /** Resumo PT-BR pro painel. */
  summary: string;
}

const PAID_FALLBACK_ALERT = 0.25; // avisa quando >25% cai no Aave pago

export class FlashHealthTracker {
  private samples: { key: FlashSourceKey; t: number }[] = [];
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts?: { windowMs?: number; now?: () => number }) {
    this.windowMs = opts?.windowMs ?? 6 * 60 * 60 * 1000; // 6h
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Registra a fonte de flashloan escolhida numa seleção. */
  observe(source: FlashSourceKey): void {
    if (!source) return;
    const t = this.now();
    this.samples.push({ key: String(source).toLowerCase(), t });
    const cutoff = t - this.windowMs;
    while (this.samples.length && this.samples[0]!.t < cutoff) this.samples.shift();
    if (this.samples.length > 5000) this.samples.splice(0, this.samples.length - 5000);
  }

  stats(): FlashHealthStats {
    const n = this.samples.length;
    const count = (k: string) => this.samples.filter((s) => s.key === k).length;
    const morpho = count('morpho');
    const balancer = count('balancer');
    const aave = count('aave');
    const pct = (c: number) => (n > 0 ? c / n : 0);
    const freeShare = pct(morpho + balancer);
    const aavePct = pct(aave);
    const degraded = n >= 5 && aavePct > PAID_FALLBACK_ALERT;
    const summary = n === 0
      ? 'sem seleção ainda'
      : degraded
        ? `${(aavePct * 100).toFixed(0)}% no Aave PAGO — fontes 0% sem liquidez pro tamanho`
        : `${(freeShare * 100).toFixed(0)}% em fontes 0% (Morpho/Balancer) — saudável`;
    return {
      samples: n,
      morphoPct: pct(morpho),
      balancerPct: pct(balancer),
      aavePct,
      freeSharePct: freeShare,
      degraded,
      summary,
    };
  }
}
