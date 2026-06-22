/**
 * Fase 0 — fundação pra trazer a inteligência "órfã" pro ledger central.
 *
 * Cobre:
 *  - buildObservationEvent aceita as categorias novas (competitor/market_bribe/...)
 *  - ingestSnapshot grava no store E é "fire-and-forget" (nunca lança, mesmo com store quebrado)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TimeseriesStore,
  buildObservationEvent,
  ingestSnapshot,
  queryTopOpportunityPairs,
} from '../src/intelligence';
import type { EventCategory } from '../src/intelligence';

function freshDb(tag: string): string {
  return join(tmpdir(), `zeus-orphan-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.duckdb`);
}
function cleanup(path: string): void {
  if (existsSync(path)) rmSync(path);
  if (existsSync(`${path}.wal`)) rmSync(`${path}.wal`);
}

const NEW_CATEGORIES: EventCategory[] = [
  'competitor', 'market_bribe', 'pnl_reconciled', 'failure_recorded', 'cluster', 'dedup',
];

describe('Fase 0 — categorias órfãs no schema', () => {
  it('buildObservationEvent aceita todas as categorias novas', () => {
    for (const category of NEW_CATEGORIES) {
      const ev = buildObservationEvent({ chain: 'Base', category, payload: { k: 1 } });
      expect(ev.category).toBe(category);
      expect(ev.source_event_type).toBe('observation');
      expect(ev.payload).toEqual({ k: 1 });
    }
  });
});

describe('Fase 0 — ingestSnapshot', () => {
  let store: TimeseriesStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = freshDb('ingest');
    store = new TimeseriesStore({ dbPath, batchSize: 1000, flushIntervalMs: 100 });
    await store.init();
  });
  afterEach(async () => {
    await store.shutdown();
    cleanup(dbPath);
  });

  it('grava o snapshot no store', async () => {
    ingestSnapshot(store, { chain: 'Base', category: 'market_bribe', pair: 'MARKET', protocol: 'bribe', profit_usd: 1.5 });
    await store.flush();
    const total = store.stats().totalEvents;
    expect(total).toBeGreaterThanOrEqual(1);
    // sanity: aparece num ranking de pares filtrado pela categoria nova
    const rows = await queryTopOpportunityPairs(store, { windowMs: 24 * 3600_000, categories: ['market_bribe'] });
    expect(rows.some((r) => r.pair === 'MARKET')).toBe(true);
  });

  it('grava perfil de competidor com sender consultável (Fase 2)', async () => {
    ingestSnapshot(store, {
      chain: 'Base', category: 'competitor', protocol: 'mev_searcher',
      sender: '0xdead', amount_usd: 87, payload: { alias: 'known-bot' },
    });
    await store.flush();
    const rows = await store.query<{ category: string; sender: string; amount_usd: number }>(
      "SELECT category, sender, amount_usd FROM events WHERE category = 'competitor'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sender).toBe('0xdead');
    expect(Number(rows[0]!.amount_usd)).toBe(87);
  });

  it('é fire-and-forget: store quebrado NÃO lança (engole o erro)', () => {
    const brokenStore = {
      ingest() {
        throw new Error('disco cheio');
      },
    };
    const warns: unknown[] = [];
    expect(() =>
      ingestSnapshot(brokenStore, { chain: 'Base', category: 'failure_recorded' }, { warn: (o) => warns.push(o) }),
    ).not.toThrow();
    expect(warns).toHaveLength(1);
  });
});
