/**
 * LatencyTracker (Fase 2b) — p50/p95 de um buffer de latências de dispatch.
 */

import { describe, expect, it } from 'vitest';
import { LatencyTracker } from '../src/analytics/latencyTracker';

describe('LatencyTracker — Fase 2b', () => {
  it('sem amostras → tudo zero (heartbeat omite o bloco)', () => {
    const t = new LatencyTracker();
    expect(t.stats()).toEqual({ p50Ms: 0, p95Ms: 0, samples: 0 });
  });

  it('calcula p50/p95 de um conjunto conhecido', () => {
    const t = new LatencyTracker();
    // 1..100 ms → p50 ≈ 50.5 → 50/51, p95 ≈ 95.x
    for (let i = 1; i <= 100; i++) t.observe(i);
    const s = t.stats();
    expect(s.samples).toBe(100);
    expect(s.p50Ms).toBeGreaterThanOrEqual(50);
    expect(s.p50Ms).toBeLessThanOrEqual(51);
    expect(s.p95Ms).toBeGreaterThanOrEqual(95);
    expect(s.p95Ms).toBeLessThanOrEqual(96);
  });

  it('ignora valores inválidos (NaN / negativos)', () => {
    const t = new LatencyTracker();
    t.observe(NaN);
    t.observe(-5);
    t.observe(120);
    expect(t.stats().samples).toBe(1);
    expect(t.stats().p50Ms).toBe(120);
  });

  it('respeita o cap do ring buffer (descarta os mais antigos)', () => {
    const t = new LatencyTracker(3);
    t.observe(10);
    t.observe(20);
    t.observe(30);
    t.observe(40); // expulsa o 10
    const s = t.stats();
    expect(s.samples).toBe(3);
    expect(s.p50Ms).toBe(30); // mediana de [20,30,40]
  });
});
