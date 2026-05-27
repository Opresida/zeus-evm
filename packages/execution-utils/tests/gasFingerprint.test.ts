/**
 * Tests pra GasFingerprintTracker + ActivityPatternTracker (Item 5 F3+F4).
 */

import { describe, expect, it } from 'vitest';

import { GasFingerprintTracker, ActivityPatternTracker } from '../src/competitors';

describe('GasFingerprintTracker — Item 5 F3', () => {
  it('observe + fingerprint retorna percentis corretos', () => {
    const t = new GasFingerprintTracker();
    // Amostras: 1, 2, 3, ..., 100 gwei
    for (let i = 1; i <= 100; i++) {
      t.observe('0xabc', i);
    }
    const fp = t.fingerprint('0xabc');
    expect(fp).not.toBeNull();
    expect(fp!.samples).toBe(100);
    // p50 ≈ 50.5 (interpolation entre 50 e 51)
    expect(fp!.p50_priority_fee_gwei).toBeCloseTo(50.5, 1);
    // p95 ≈ 95.05
    expect(fp!.p95_priority_fee_gwei).toBeGreaterThan(94);
    expect(fp!.p95_priority_fee_gwei).toBeLessThan(96);
    // p99 ≈ 99.01
    expect(fp!.p99_priority_fee_gwei).toBeGreaterThan(98);
    expect(fp!.min_priority_fee_gwei).toBe(1);
    expect(fp!.max_priority_fee_gwei).toBe(100);
    expect(fp!.avg_priority_fee_gwei).toBeCloseTo(50.5, 1);
  });

  it('sliding window descarta amostras antigas', () => {
    const t = new GasFingerprintTracker({ windowSize: 10 });
    // 15 amostras: 1, 2, ..., 15 — só últimas 10 ficam (6..15)
    for (let i = 1; i <= 15; i++) {
      t.observe('0xabc', i);
    }
    const fp = t.fingerprint('0xabc');
    expect(fp!.samples).toBe(10);
    expect(fp!.min_priority_fee_gwei).toBe(6); // primeiras 5 descartadas
    expect(fp!.max_priority_fee_gwei).toBe(15);
  });

  it('observe ignora valores inválidos (0, negativos, NaN)', () => {
    const t = new GasFingerprintTracker();
    t.observe('0xabc', 0);
    t.observe('0xabc', -5);
    t.observe('0xabc', NaN);
    t.observe('0xabc', 10);

    const fp = t.fingerprint('0xabc');
    expect(fp!.samples).toBe(1);
    expect(fp!.min_priority_fee_gwei).toBe(10);
  });

  it('fingerprint retorna null se sender não rastreado', () => {
    const t = new GasFingerprintTracker();
    expect(t.fingerprint('0xunknown')).toBeNull();
  });

  it('topByP95 ordena por agressividade de gas', () => {
    const t = new GasFingerprintTracker();
    for (let i = 0; i < 20; i++) {
      t.observe('0xlow', 1 + Math.random() * 0.5); // 1-1.5
      t.observe('0xmid', 5 + Math.random() * 1);   // 5-6
      t.observe('0xhigh', 20 + Math.random() * 5); // 20-25
    }
    const top = t.topByP95(3);
    expect(top[0]!.sender).toBe('0xhigh');
    expect(top[1]!.sender).toBe('0xmid');
    expect(top[2]!.sender).toBe('0xlow');
  });

  it('snapshot + restore preserva state', () => {
    const t = new GasFingerprintTracker();
    for (let i = 0; i < 10; i++) t.observe('0xabc', i + 1);
    const snap = t.snapshot();

    const t2 = new GasFingerprintTracker();
    t2.restore(snap);
    const fp = t2.fingerprint('0xabc');
    expect(fp!.samples).toBe(10);
  });
});

describe('ActivityPatternTracker — Item 5 F4', () => {
  it('observe + pattern retorna distribuição por hora UTC', () => {
    const t = new ActivityPatternTracker();
    // 10 txs na hora 14 UTC
    const ts14 = Date.UTC(2026, 4, 27, 14, 0, 0);
    for (let i = 0; i < 10; i++) {
      t.observe('0xabc', ts14 + i * 1000);
    }
    // 2 txs na hora 3 UTC
    const ts3 = Date.UTC(2026, 4, 27, 3, 0, 0);
    for (let i = 0; i < 2; i++) {
      t.observe('0xabc', ts3 + i * 1000);
    }

    const p = t.pattern('0xabc');
    expect(p).not.toBeNull();
    expect(p!.total_txs).toBe(12);
    expect(p!.peak_hour_utc).toBe(14);
    expect(p!.peak_hour_txs).toBe(10);
    // Active hours com threshold 5% (mínimo 0.6 txs) → 14 e 3
    expect(p!.active_hours_utc).toContain(14);
    expect(p!.active_hours_utc).toContain(3);
  });

  it('burst detection: 5+ txs em 60s = burst', () => {
    const t = new ActivityPatternTracker();
    const baseTs = Date.now();
    // 5 txs em 10 segundos = burst
    for (let i = 0; i < 5; i++) {
      t.observe('0xabc', baseTs + i * 2000);
    }
    const p = t.pattern('0xabc');
    expect(p!.bursts_detected).toBeGreaterThanOrEqual(1);
  });

  it('5 txs em 5min (não atinge burstWindow padrão 60s) NÃO conta burst', () => {
    const t = new ActivityPatternTracker();
    const baseTs = Date.now();
    // 5 txs espaçadas 80s entre cada = 320s span
    for (let i = 0; i < 5; i++) {
      t.observe('0xabc', baseTs + i * 80_000);
    }
    const p = t.pattern('0xabc');
    expect(p!.bursts_detected).toBe(0);
  });

  it('weekday_distribution preenche corretamente', () => {
    const t = new ActivityPatternTracker();
    // 27/05/2026 = quarta-feira (weekday=3)
    const wed = Date.UTC(2026, 4, 27, 14, 0, 0);
    t.observe('0xabc', wed);
    const p = t.pattern('0xabc');
    expect(p!.weekday_distribution[3]).toBe(1);
  });

  it('topByBursts ordena por count', () => {
    const t = new ActivityPatternTracker();
    // 0xbursty tem 2 bursts
    const baseTs = Date.now();
    for (let i = 0; i < 5; i++) t.observe('0xbursty', baseTs + i * 1000);
    for (let i = 0; i < 5; i++) t.observe('0xbursty', baseTs + 70_000 + i * 1000);

    // 0xslow nenhum burst
    for (let i = 0; i < 3; i++) t.observe('0xslow', baseTs + i * 100_000);

    const top = t.topByBursts(5);
    expect(top.length).toBeGreaterThan(0);
    expect(top[0]!.sender).toBe('0xbursty');
  });

  it('pattern retorna null se sender desconhecido', () => {
    const t = new ActivityPatternTracker();
    expect(t.pattern('0xunknown')).toBeNull();
  });

  it('longest_silence_ms captura maior gap', () => {
    const t = new ActivityPatternTracker();
    const baseTs = Date.now();
    t.observe('0xabc', baseTs);
    t.observe('0xabc', baseTs + 1000);
    t.observe('0xabc', baseTs + 1_001_000); // 1000s gap

    const p = t.pattern('0xabc');
    expect(p!.longest_silence_ms).toBeGreaterThanOrEqual(1_000_000);
  });
});
