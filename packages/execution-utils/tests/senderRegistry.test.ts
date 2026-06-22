/**
 * Smoke test do SenderRegistry (Item 5 F1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SenderRegistry } from '../src/competitors';

function freshDir(): string {
  return join(
    tmpdir(),
    `zeus-registry-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
}

describe('SenderRegistry — Item 5 F1', () => {
  let baseDir: string;
  let registry: SenderRegistry;

  beforeEach(() => {
    baseDir = freshDir();
    registry = new SenderRegistry({ baseDir });
  });

  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  });

  it('observe cria profile novo + incrementa total_txs', () => {
    registry.observe({
      sender: '0xabc' as `0x${string}`,
      protocol: 'aave_v3',
      priority_fee_gwei: 2.5,
      hour_utc: 14,
      weekday: 1,
      timestamp: Date.now(),
    });

    const profile = registry.get('0xabc' as `0x${string}`);
    expect(profile).toBeDefined();
    expect(profile!.total_txs).toBe(1);
    expect(profile!.protocols.aave_v3.txs).toBe(1);
    expect(profile!.gas.avg_priority_fee_gwei).toBeCloseTo(2.5);
  });

  it('observe agrega txs do mesmo sender', () => {
    for (let i = 0; i < 5; i++) {
      registry.observe({
        sender: '0xabc' as `0x${string}`,
        protocol: 'aave_v3',
        priority_fee_gwei: 2 + i,
        hour_utc: 14,
        weekday: 1,
        timestamp: Date.now(),
      });
    }

    const profile = registry.get('0xabc' as `0x${string}`)!;
    expect(profile.total_txs).toBe(5);
    expect(profile.protocols.aave_v3.txs).toBe(5);
    // p95 acumula via running max → maior valor visto
    expect(profile.gas.p95_priority_fee_gwei).toBe(6);
  });

  it('multiple senders são tracked separadamente', () => {
    registry.observe({
      sender: '0xaaa' as `0x${string}`,
      protocol: 'aave_v3',
      hour_utc: 0,
      weekday: 0,
      timestamp: Date.now(),
    });
    registry.observe({
      sender: '0xbbb' as `0x${string}`,
      protocol: 'uniswap_v3',
      hour_utc: 0,
      weekday: 0,
      timestamp: Date.now(),
    });

    const stats = registry.stats();
    expect(stats.total_profiles).toBe(2);
  });

  it('reclassify pra liquidator quando >70% txs em protocols liquidation', () => {
    const sender = '0xliq' as `0x${string}`;
    for (let i = 0; i < 60; i++) {
      registry.observe({
        sender,
        protocol: 'aave_v3',
        hour_utc: 14,
        weekday: 1,
        timestamp: Date.now(),
      });
    }
    // Dispara reclassify (a cada 50 txs)
    const profile = registry.get(sender)!;
    expect(profile.category).toBe('liquidator');
    expect(profile.tags).toContain('aave_liquidator');
  });

  it('reclassify pra generic_arber quando >70% txs em DEX', () => {
    const sender = '0xarb' as `0x${string}`;
    for (let i = 0; i < 100; i++) {
      registry.observe({
        sender,
        protocol: 'uniswap_v3',
        hour_utc: 14,
        weekday: 1,
        timestamp: Date.now(),
      });
    }
    const profile = registry.get(sender)!;
    expect(profile.category).toBe('generic_arber');
  });

  it('saveSnapshot + reload preserva profiles', () => {
    registry.observe({
      sender: '0xabc' as `0x${string}`,
      protocol: 'aave_v3',
      priority_fee_gwei: 3,
      hour_utc: 12,
      weekday: 3,
      timestamp: Date.now(),
    });
    registry.saveSnapshot();

    // Cria novo registry no mesmo dir — deve carregar
    const restored = new SenderRegistry({ baseDir });
    const profile = restored.get('0xabc' as `0x${string}`);
    expect(profile).toBeDefined();
    expect(profile!.total_txs).toBe(1);
    expect(profile!.gas.avg_priority_fee_gwei).toBeCloseTo(3);
  });

  // ─── Fase 1: market-bribe ───
  describe('marketBribeStats', () => {
    function feed(sender: `0x${string}`, fee: number, n: number, ts: number) {
      for (let i = 0; i < n; i++) {
        registry.observe({ sender, protocol: 'aave_v3', priority_fee_gwei: fee, hour_utc: 1, weekday: 1, timestamp: ts });
      }
    }

    it('registry vazio → zeros', () => {
      const m = registry.marketBribeStats();
      expect(m.competitorsActive).toBe(0);
      expect(m.p50Gwei).toBe(0);
      expect(m.p75Gwei).toBe(0);
      expect(m.p95Gwei).toBe(0);
    });

    it('agrega percentis entre competidores ativos', () => {
      const now = 1_700_000_000_000;
      feed('0xa' as `0x${string}`, 1, 3, now); // avg 1
      feed('0xb' as `0x${string}`, 2, 3, now); // avg 2
      feed('0xc' as `0x${string}`, 3, 3, now); // avg 3
      const m = registry.marketBribeStats({ now });
      expect(m.competitorsActive).toBe(3);
      expect(m.samples).toBe(9);
      expect(m.avgGwei).toBeCloseTo(2, 4);
      expect(m.p50Gwei).toBeCloseTo(2, 4);
      expect(m.p75Gwei).toBeCloseTo(2.5, 4);
      // p95 de mercado = max(percentil dos avgs, maior p95 por-perfil=3) = 3
      expect(m.p95Gwei).toBeCloseTo(3, 4);
    });

    it('ignora competidores inativos (fora da janela)', () => {
      const now = 1_700_000_000_000;
      feed('0xrecent' as `0x${string}`, 5, 3, now);
      feed('0xold' as `0x${string}`, 99, 3, now - 2 * 60 * 60 * 1000); // 2h atrás
      const m = registry.marketBribeStats({ now, activeWithinMs: 60 * 60 * 1000 });
      expect(m.competitorsActive).toBe(1);
      expect(m.avgGwei).toBeCloseTo(5, 4);
    });

    it('ignora perfis com poucas amostras (minSamples)', () => {
      const now = 1_700_000_000_000;
      feed('0xok' as `0x${string}`, 4, 3, now);   // 3 amostras
      feed('0xthin' as `0x${string}`, 50, 2, now); // só 2 amostras → fora
      const m = registry.marketBribeStats({ now, minSamples: 3 });
      expect(m.competitorsActive).toBe(1);
      expect(m.avgGwei).toBeCloseTo(4, 4);
    });
  });

  it('topThreats ordena por threat.overall_score', () => {
    // Sender com muitas txs + gas alto = threat alto
    for (let i = 0; i < 100; i++) {
      registry.observe({
        sender: '0xhigh' as `0x${string}`,
        protocol: 'aave_v3',
        priority_fee_gwei: 5,
        hour_utc: 14,
        weekday: 1,
        timestamp: Date.now(),
      });
    }
    // Sender com poucas txs + gas baixo = threat baixo
    registry.observe({
      sender: '0xlow' as `0x${string}`,
      protocol: 'uniswap_v3',
      priority_fee_gwei: 0.01,
      hour_utc: 14,
      weekday: 1,
      timestamp: Date.now(),
    });

    const top = registry.topThreats(2);
    expect(top.length).toBe(2);
    expect(top[0]!.sender).toBe('0xhigh');
    expect(top[0]!.threat.overall_score).toBeGreaterThan(top[1]!.threat.overall_score);
  });
});
