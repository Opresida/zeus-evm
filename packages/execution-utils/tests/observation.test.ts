/**
 * Testes do módulo de observação (DRY_RUN intelligence):
 *  - buildObservationEvent (builder puro)
 *  - resolveIntelligenceDbPath (env override)
 *  - queryTopOpportunityPairs (ranking num store)
 *  - attachAndRankPairs (unificação cross-motor via ATTACH)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TimeseriesStore,
  buildObservationEvent,
  resolveIntelligenceDbPath,
  queryTopOpportunityPairs,
  attachAndRankPairs,
} from '../src/intelligence';

function freshDb(tag: string): string {
  return join(tmpdir(), `zeus-obs-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.duckdb`);
}

function cleanup(path: string): void {
  if (existsSync(path)) rmSync(path);
  if (existsSync(`${path}.wal`)) rmSync(`${path}.wal`);
}

describe('buildObservationEvent', () => {
  it('preenche id, dimensões temporais e defaults', () => {
    const ev = buildObservationEvent({
      chain: 'Base',
      category: 'arb_observed',
      protocol: 'arb',
      pair: 'AERO/USDC',
      profit_usd: 3.2,
    });
    expect(ev.id).toBeTruthy();
    expect(ev.source_event_type).toBe('observation');
    expect(ev.mode).toBe('dryrun');
    expect(ev.severity).toBe('info');
    expect(ev.category).toBe('arb_observed');
    expect(ev.pair).toBe('AERO/USDC');
    expect(ev.hour_utc).toBeGreaterThanOrEqual(0);
    expect(ev.hour_utc).toBeLessThanOrEqual(23);
    expect(ev.payload).toEqual({});
  });
});

describe('resolveIntelligenceDbPath', () => {
  it('usa INTELLIGENCE_DB_PATH quando setado', () => {
    const prev = process.env.INTELLIGENCE_DB_PATH;
    process.env.INTELLIGENCE_DB_PATH = '/data/x.duckdb';
    expect(resolveIntelligenceDbPath('y.duckdb')).toBe('/data/x.duckdb');
    if (prev === undefined) delete process.env.INTELLIGENCE_DB_PATH;
    else process.env.INTELLIGENCE_DB_PATH = prev;
  });

  it('fallback pra logs/<basename> sem env', () => {
    const prev = process.env.INTELLIGENCE_DB_PATH;
    delete process.env.INTELLIGENCE_DB_PATH;
    expect(resolveIntelligenceDbPath('intelligence-detector.duckdb')).toMatch(/logs\/intelligence-detector\.duckdb$/);
    if (prev !== undefined) process.env.INTELLIGENCE_DB_PATH = prev;
  });
});

describe('queryTopOpportunityPairs', () => {
  let store: TimeseriesStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = freshDb('rank');
    store = new TimeseriesStore({ dbPath, batchSize: 1000, flushIntervalMs: 100 });
    await store.init();
  });
  afterEach(async () => {
    await store.shutdown();
    cleanup(dbPath);
  });

  it('ranqueia pares por frequência + lucro + persistência', async () => {
    // AERO/USDC: 5 obs ($3 cada) em 2 horas distintas
    for (let i = 0; i < 5; i++) {
      store.ingest(buildObservationEvent({
        chain: 'Base', category: 'arb_observed', protocol: 'arb', pair: 'AERO/USDC',
        profit_usd: 3, timestamp: Date.now() - i * 3600_000,
      }));
    }
    // VIRTUAL/WETH: 2 obs ($1 cada)
    for (let i = 0; i < 2; i++) {
      store.ingest(buildObservationEvent({
        chain: 'Base', category: 'arb_observed', protocol: 'arb', pair: 'VIRTUAL/WETH', profit_usd: 1,
      }));
    }
    await store.flush();

    const ranking = await queryTopOpportunityPairs(store, { windowMs: 24 * 3600_000 });
    expect(ranking[0]!.pair).toBe('AERO/USDC');
    expect(ranking[0]!.observations).toBe(5);
    expect(ranking[0]!.avg_profit_usd).toBeCloseTo(3, 1);
    expect(ranking[0]!.total_profit_usd).toBeCloseTo(15, 1);
    expect(ranking[0]!.active_hours).toBeGreaterThanOrEqual(2);
  });

  it('filtra por chain', async () => {
    store.ingest(buildObservationEvent({ chain: 'Base', category: 'arb_observed', pair: 'A/B', profit_usd: 1 }));
    store.ingest(buildObservationEvent({ chain: 'Arbitrum', category: 'arb_observed', pair: 'A/B', profit_usd: 1 }));
    await store.flush();
    const base = await queryTopOpportunityPairs(store, { windowMs: 24 * 3600_000, chain: 'Base' });
    expect(base.reduce((s, r) => s + r.observations, 0)).toBe(1);
  });
});

describe('attachAndRankPairs — unificação cross-motor', () => {
  let detPath: string;
  let misPath: string;
  let det: TimeseriesStore;
  let mis: TimeseriesStore;

  beforeEach(async () => {
    detPath = freshDb('det');
    misPath = freshDb('mis');
    det = new TimeseriesStore({ dbPath: detPath, batchSize: 1000 });
    mis = new TimeseriesStore({ dbPath: misPath, batchSize: 1000 });
    await det.init();
    await mis.init();
  });
  afterEach(async () => {
    await det.shutdown();
    await mis.shutdown();
    cleanup(detPath);
    cleanup(misPath);
  });

  it('soma observações do detector + MIS no mesmo par', async () => {
    // detector vê AERO/USDC 3x
    for (let i = 0; i < 3; i++) {
      det.ingest(buildObservationEvent({ chain: 'Base', category: 'arb_observed', protocol: 'arb', pair: 'AERO/USDC', profit_usd: 2 }));
    }
    await det.flush();
    // MIS vê AERO/USDC 4x (arquivo separado)
    for (let i = 0; i < 4; i++) {
      mis.ingest(buildObservationEvent({ chain: 'Base', category: 'mis_observed', protocol: 'mis', pair: 'AERO/USDC', profit_usd: 5 }));
    }
    await mis.flush();

    // Unifica: primary = det, anexa mis
    const ranking = await attachAndRankPairs(det, [misPath], { windowMs: 24 * 3600_000 });
    const aero = ranking.filter((r) => r.pair === 'AERO/USDC');
    const totalObs = aero.reduce((s, r) => s + r.observations, 0);
    expect(totalObs).toBe(7); // 3 (arb) + 4 (mis)
  });
});
