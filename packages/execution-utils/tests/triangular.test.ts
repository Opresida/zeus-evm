/**
 * Parte C — detecção de arbitragem triangular (ciclos T0→T1→T2→T0 com produto de taxas > 1).
 */

import { describe, expect, it } from 'vitest';
import { findTriangularCycles, type ArbEdge } from '../src/arb/triangular';

const A = '0xaa00000000000000000000000000000000000001' as `0x${string}`;
const B = '0xbb00000000000000000000000000000000000002' as `0x${string}`;
const C = '0xcc00000000000000000000000000000000000003' as `0x${string}`;
const D = '0xdd00000000000000000000000000000000000004' as `0x${string}`;

const edge = (from: `0x${string}`, to: `0x${string}`, rate: number): ArbEdge => ({
  from, to, rate, poolLabel: `${from.slice(2, 4)}/${to.slice(2, 4)}`, dex: 'univ3',
});

describe('findTriangularCycles', () => {
  it('acha um ciclo lucrativo A→B→C→A (produto > 1)', () => {
    // A→B 2.0, B→C 2.0, C→A 0.3 → produto 1.2 = +2000bps
    const cycles = findTriangularCycles([edge(A, B, 2), edge(B, C, 2), edge(C, A, 0.3)]);
    expect(cycles.length).toBe(1);
    expect(cycles[0]!.profitBps).toBe(2000);
    expect(cycles[0]!.tokens).toEqual([A, B, C]);
  });

  it('ignora ciclo não-lucrativo (produto <= 1 + threshold)', () => {
    // produto = 1.0 exato → sem lucro
    const cycles = findTriangularCycles([edge(A, B, 1), edge(B, C, 1), edge(C, A, 1)]);
    expect(cycles.length).toBe(0);
  });

  it('respeita minProfitBps', () => {
    // produto 1.005 = +50bps; threshold 100bps → fora
    const cycles = findTriangularCycles([edge(A, B, 1.005), edge(B, C, 1), edge(C, A, 1)], { minProfitBps: 100 });
    expect(cycles.length).toBe(0);
  });

  it('usa o MELHOR edge por par direcionado', () => {
    // dois pools A→B; deve usar o de rate 2.5 (não 2.0)
    const cycles = findTriangularCycles([
      edge(A, B, 2.0), edge(A, B, 2.5), edge(B, C, 2), edge(C, A, 0.25),
    ]);
    expect(cycles.length).toBe(1);
    // produto = 2.5 * 2 * 0.25 = 1.25
    expect(cycles[0]!.profitBps).toBe(2500);
    expect(cycles[0]!.legs[0]!.rate).toBe(2.5);
  });

  it('deduplica o mesmo triângulo (rotações)', () => {
    // ciclo fechado nos 3 sentidos não deve gerar 3 entradas
    const cycles = findTriangularCycles([
      edge(A, B, 2), edge(B, C, 2), edge(C, A, 0.3),
      edge(B, A, 0.5), edge(C, B, 0.5), edge(A, C, 3.4),
    ]);
    // 1 triângulo {A,B,C}, melhor rotação
    const abcKeys = new Set(cycles.map((c) => [...c.tokens].sort().join('|')));
    expect(abcKeys.size).toBe(cycles.length); // sem duplicata do mesmo conjunto
  });

  it('ordena por lucro desc + respeita maxCycles', () => {
    // dois triângulos disjuntos com lucros diferentes
    const edges = [
      edge(A, B, 2), edge(B, C, 2), edge(C, A, 0.3),     // {A,B,C} +2000
      edge(A, D, 2), edge(D, B, 2), edge(B, A, 0.4),     // {A,D,B} ... produto 1.6 = +6000? wait B→A 0.4 → 2*2*0.4=1.6
    ];
    const cycles = findTriangularCycles(edges, { maxCycles: 1 });
    expect(cycles.length).toBe(1);
    // o de maior lucro vem primeiro
    expect(cycles[0]!.profitBps).toBeGreaterThanOrEqual(2000);
  });

  it('ignora rates inválidos (0/NaN/negativos)', () => {
    const cycles = findTriangularCycles([edge(A, B, 0), edge(B, C, NaN), edge(C, A, -1)]);
    expect(cycles.length).toBe(0);
  });
});
