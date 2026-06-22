/**
 * Detecção de arbitragem TRIANGULAR (ver "na profundidade") — Motor 2.
 *
 * Cross-DEX 2-leg vê divergência do MESMO par em 2 pools. Triangular vê a ineficiência entre 3
 * mercados: um ciclo T0 → T1 → T2 → T0 onde o PRODUTO das taxas (já com fee) > 1 = lucro.
 *
 * Algoritmo (rápido — latência decide): reduzimos pro melhor edge por par DIRECIONADO
 * (pra um hop, sempre usaríamos o pool de melhor taxa), e aí a busca é sobre TOKENS distintos
 * (O(V³) com V = dezenas). Puro, sem I/O → unit-testável.
 *
 * `rate` de um edge = unidades de `to` por 1 unidade de `from` (spot já ajustado por fee).
 * Quem alimenta os edges (ex: o MIS, a partir dos pools varridos) é responsável por aplicar a fee.
 */

import type { Address } from 'viem';

export interface ArbEdge {
  /** Token de entrada do hop. */
  from: Address;
  /** Token de saída do hop. */
  to: Address;
  /** Unidades de `to` por 1 de `from` (spot, fee-adjusted). > 0. */
  rate: number;
  /** Label do pool (ex: 'UniV3-500') — pra montar o calldata depois. */
  poolLabel: string;
  /** DEX do pool. */
  dex: string;
}

export interface TriangularCycle {
  /** Ciclo T0 → T1 → T2 → T0. */
  tokens: [Address, Address, Address];
  /** Os 3 edges na ordem do ciclo. */
  legs: [ArbEdge, ArbEdge, ArbEdge];
  /** Produto das taxas (r1·r2·r3). > 1 = lucrativo. */
  product: number;
  /** Lucro em bps = (produto − 1) · 10000. */
  profitBps: number;
}

export interface FindTriangularOpts {
  /** Lucro mínimo (bps) pra reportar. Default 10 (0,1%). */
  minProfitBps?: number;
  /** Máx de ciclos retornados (ordenados por lucro). Default 20. */
  maxCycles?: number;
}

const lc = (a: Address): string => a.toLowerCase();

/**
 * Reduz a lista de edges pro MELHOR edge (maior rate) por par direcionado (from→to).
 * Pra um hop, sempre usaríamos o pool com a melhor taxa.
 */
function bestEdges(edges: ArbEdge[]): Map<string, Map<string, ArbEdge>> {
  const best = new Map<string, Map<string, ArbEdge>>();
  for (const e of edges) {
    if (!(e.rate > 0) || !Number.isFinite(e.rate)) continue;
    const f = lc(e.from);
    const t = lc(e.to);
    if (f === t) continue;
    let row = best.get(f);
    if (!row) { row = new Map(); best.set(f, row); }
    const cur = row.get(t);
    if (!cur || e.rate > cur.rate) row.set(t, e);
  }
  return best;
}

/**
 * Acha ciclos triangulares lucrativos. Dedup por conjunto de tokens (cada triângulo aparece 1x,
 * na rotação de melhor produto). Ordena por lucro desc.
 */
export function findTriangularCycles(edges: ArbEdge[], opts: FindTriangularOpts = {}): TriangularCycle[] {
  const minProfitBps = opts.minProfitBps ?? 10;
  const maxCycles = opts.maxCycles ?? 20;
  const threshold = 1 + minProfitBps / 10_000;

  const best = bestEdges(edges);
  const tokens = [...best.keys()];

  const seen = new Set<string>(); // chave canônica do conjunto {t0,t1,t2}
  const out: TriangularCycle[] = [];

  for (const t0 of tokens) {
    const n0 = best.get(t0);
    if (!n0) continue;
    for (const [t1, e1] of n0) {
      if (t1 === t0) continue;
      const n1 = best.get(t1);
      if (!n1) continue;
      for (const [t2, e2] of n1) {
        if (t2 === t0 || t2 === t1) continue;
        const n2 = best.get(t2);
        if (!n2) continue;
        const e3 = n2.get(t0); // fecha o ciclo de volta pro t0
        if (!e3) continue;

        const product = e1.rate * e2.rate * e3.rate;
        if (product <= threshold) continue;

        // Dedup: mesmo triângulo independente do ponto de partida.
        const key = [t0, t1, t2].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          tokens: [e1.from, e2.from, e3.from],
          legs: [e1, e2, e3],
          product,
          profitBps: Math.round((product - 1) * 10_000),
        });
      }
    }
  }

  return out.sort((a, b) => b.profitBps - a.profitBps).slice(0, maxCycles);
}
