/**
 * #8 automação — Pool depth (profundidade de liquidez) observável.
 *
 * O bot já lê a profundidade de cada pool ao cotar (slot0/reserves). Este tracker guarda uma janela
 * rolante por pool e detecta QUEDA BRUSCA de profundidade (ex.: −30% em ~1h) — sinal de liquidez
 * saindo (rug/pull) ou pool esvaziando. Observe-first: avisa "reduziria o tamanho / evitaria esse pool"
 * antes de qualquer ação. Roda em DRY_RUN (a profundidade é lida na varredura, não precisa executar).
 *
 * Regras: piso/teto + histerese (exige N amostras + drop mínimo), avisa no painel, reversível.
 */

export interface PoolDepthAlert {
  poolKey: string;
  label?: string;
  nowUsd: number;
  refUsd: number; // profundidade de referência (máx recente na janela)
  dropPct: number; // 0..1 (0.3 = caiu 30%)
}

export interface PoolDepthSummary {
  tracked: number;
  degraded: PoolDepthAlert[];
}

interface Sample {
  usd: number;
  t: number;
}

const MIN_SAMPLES = 3; // histerese: precisa de histórico antes de alertar
const DEFAULT_DROP = 0.3; // alerta em queda ≥30%

export class PoolDepthTracker {
  private byPool = new Map<string, { label?: string; samples: Sample[] }>();
  private readonly windowMs: number;
  private readonly dropThreshold: number;
  private readonly now: () => number;

  constructor(opts?: { windowMs?: number; dropThreshold?: number; now?: () => number }) {
    this.windowMs = opts?.windowMs ?? 60 * 60 * 1000; // 1h
    this.dropThreshold = opts?.dropThreshold ?? DEFAULT_DROP;
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Registra a profundidade (USD) de um pool numa amostra da varredura. */
  observe(poolKey: string, depthUsd: number, label?: string): void {
    if (!poolKey || !Number.isFinite(depthUsd) || depthUsd <= 0) return;
    const t = this.now();
    let e = this.byPool.get(poolKey);
    if (!e) {
      e = { label, samples: [] };
      this.byPool.set(poolKey, e);
    }
    if (label) e.label = label;
    e.samples.push({ usd: depthUsd, t });
    this.pruneOne(e, t);
    // Cap de memória: não rastrear pools infinitos.
    if (this.byPool.size > 500) this.evictOldest();
  }

  private pruneOne(e: { samples: Sample[] }, now: number): void {
    const cutoff = now - this.windowMs;
    while (e.samples.length && e.samples[0]!.t < cutoff) e.samples.shift();
    if (e.samples.length > 500) e.samples.splice(0, e.samples.length - 500);
  }

  private evictOldest(): void {
    // Remove pools sem amostra recente.
    const cutoff = this.now() - this.windowMs;
    for (const [k, e] of this.byPool) {
      if (!e.samples.length || e.samples[e.samples.length - 1]!.t < cutoff) this.byPool.delete(k);
    }
  }

  /** Pools que caíram ≥ threshold na janela (vs. o pico recente). */
  alerts(): PoolDepthAlert[] {
    const now = this.now();
    const out: PoolDepthAlert[] = [];
    for (const [poolKey, e] of this.byPool) {
      this.pruneOne(e, now);
      if (e.samples.length < MIN_SAMPLES) continue;
      const nowUsd = e.samples[e.samples.length - 1]!.usd;
      const refUsd = Math.max(...e.samples.map((s) => s.usd));
      if (refUsd <= 0) continue;
      const dropPct = (refUsd - nowUsd) / refUsd;
      if (dropPct >= this.dropThreshold) {
        out.push({ poolKey, label: e.label, nowUsd, refUsd, dropPct });
      }
    }
    return out.sort((a, b) => b.dropPct - a.dropPct);
  }

  summary(): PoolDepthSummary {
    return { tracked: this.byPool.size, degraded: this.alerts() };
  }
}
