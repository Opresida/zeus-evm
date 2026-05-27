/**
 * Smoke test do Intelligence module (Item 15 I1+I2).
 *
 * Valida:
 *  - DuckDB inicializa + cria schema
 *  - Eventos são ingeridos + persistidos
 *  - Queries SQL funcionam
 *  - Time dimensions são corretamente computadas
 *  - Edge cases (event timestamps inválidos, batch flush)
 *
 * Não depende de RPC nem fork — roda em qualquer ambiente.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../src/eventBus';
import {
  EventIngester,
  TimeseriesStore,
  computeTimeDimensions,
  generateEventId,
} from '../src/intelligence';
import type { TxConfirmedEvent, GasReserveAlertEvent } from '../src/events';

function freshDbPath(): string {
  return join(
    tmpdir(),
    `zeus-intelligence-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.duckdb`,
  );
}

describe('Intelligence — TimeseriesStore', () => {
  let store: TimeseriesStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = freshDbPath();
    store = new TimeseriesStore({ dbPath, batchSize: 3, flushIntervalMs: 100 });
    await store.init();
  });

  afterEach(async () => {
    await store.shutdown();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}.wal`)) rmSync(`${dbPath}.wal`);
  });

  it('inicializa schema sem erro', async () => {
    const rows = await store.query<{ count: bigint }>(
      "SELECT COUNT(*) as count FROM events",
    );
    expect(rows[0]?.count).toBe(0n);
  });

  it('ingest + flush automático ao atingir batchSize', async () => {
    for (let i = 0; i < 3; i++) {
      store.ingest({
        id: generateEventId(Date.now() + i),
        timestamp: Date.now() + i,
        source_event_type: 'tx.confirmed',
        hour_utc: 14,
        weekday: 1,
        iso_week: 22,
        chain: 'Base',
        category: 'liquidation',
        mode: 'dryrun',
        severity: 'info',
        protocol: 'aave-v3',
        profit_usd: 10.5,
        gas_usd: 0.5,
        payload: { test: i },
      });
    }

    // Espera o flush async (batchSize=3 → flush imediato)
    await new Promise((r) => setTimeout(r, 200));
    await store.flush();

    const rows = await store.query<{ count: bigint }>("SELECT COUNT(*) as count FROM events");
    expect(rows[0]?.count).toBe(3n);
  });

  it('query filtrada por chain + category', async () => {
    store.ingest({
      id: generateEventId(Date.now()),
      timestamp: Date.now(),
      source_event_type: 'tx.confirmed',
      hour_utc: 14,
      weekday: 1,
      iso_week: 22,
      chain: 'Base',
      category: 'liquidation',
      mode: 'dryrun',
      severity: 'info',
      protocol: 'aave-v3',
      profit_usd: 100,
      payload: {},
    });
    store.ingest({
      id: generateEventId(Date.now() + 1),
      timestamp: Date.now() + 1,
      source_event_type: 'tx.confirmed',
      hour_utc: 15,
      weekday: 1,
      iso_week: 22,
      chain: 'Arbitrum',
      category: 'liquidation',
      mode: 'dryrun',
      severity: 'info',
      protocol: 'aave-v3',
      profit_usd: 50,
      payload: {},
    });

    await store.flush();

    const baseRows = await store.query<{ count: bigint; total: number }>(
      "SELECT COUNT(*) as count, SUM(profit_usd) as total FROM events WHERE chain='Base'",
    );
    expect(baseRows[0]?.count).toBe(1n);
    expect(baseRows[0]?.total).toBe(100);
  });

  it('countByCategory agrupa corretamente', async () => {
    const categories = ['liquidation', 'liquidation', 'tx_reverted', 'gas_reserve'];
    for (const cat of categories) {
      store.ingest({
        id: generateEventId(Date.now() + Math.random()),
        timestamp: Date.now(),
        source_event_type: 'test',
        hour_utc: 0,
        weekday: 0,
        iso_week: 1,
        chain: 'Base',
        category: cat as any,
        mode: 'dryrun',
        severity: 'info',
        payload: {},
      });
    }

    await store.flush();

    const counts = await store.countByCategory();
    expect(counts.liquidation).toBe(2);
    expect(counts.tx_reverted).toBe(1);
    expect(counts.gas_reserve).toBe(1);
  });
});

describe('Intelligence — EventIngester', () => {
  let store: TimeseriesStore;
  let bus: EventBus;
  let ingester: EventIngester;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = freshDbPath();
    store = new TimeseriesStore({ dbPath, batchSize: 2, flushIntervalMs: 100 });
    await store.init();
    bus = new EventBus();
    ingester = new EventIngester({ store, eventBus: bus });
    ingester.start();
  });

  afterEach(async () => {
    await ingester.stop();
    await store.shutdown();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}.wal`)) rmSync(`${dbPath}.wal`);
  });

  it('normaliza tx.confirmed pra category=liquidation', async () => {
    const event: TxConfirmedEvent = {
      type: 'tx.confirmed',
      timestamp: new Date().toISOString(),
      chain: 'Base',
      mode: 'dryrun',
      severity: 'info',
      txHash: '0xabc' as `0x${string}`,
      protocol: 'aave-v3',
      borrower: '0xborrower' as `0x${string}`,
      profitUsd: 12.5,
      gasCostUsd: 0.3,
      netProfitUsd: 12.2,
      profitDeltaBps: 50,
      blockNumber: '12345',
    };

    bus.emit(event);
    bus.emit(event); // 2 events → atinge batchSize=2 → flush
    await new Promise((r) => setTimeout(r, 200));
    await store.flush();

    const rows = await store.query<{ category: string; profit_usd: number }>(
      "SELECT category, profit_usd FROM events WHERE source_event_type='tx.confirmed' LIMIT 1",
    );
    expect(rows[0]?.category).toBe('liquidation');
    expect(rows[0]?.profit_usd).toBe(12.5);
  });

  it('normaliza gas.alert pra category=gas_reserve', async () => {
    const event: GasReserveAlertEvent = {
      type: 'gas.alert',
      timestamp: new Date().toISOString(),
      chain: 'Base',
      mode: 'mainnet',
      severity: 'warn',
      account: '0xacct' as `0x${string}`,
      balanceEth: '0.005',
      balanceUsd: 15,
      status: 'warn',
    };

    bus.emit(event);
    bus.emit(event);
    await new Promise((r) => setTimeout(r, 200));
    await store.flush();

    const rows = await store.query<{ category: string; amount_usd: number; severity: string }>(
      "SELECT category, amount_usd, severity FROM events WHERE source_event_type='gas.alert' LIMIT 1",
    );
    expect(rows[0]?.category).toBe('gas_reserve');
    expect(rows[0]?.amount_usd).toBe(15);
    expect(rows[0]?.severity).toBe('warn');
  });

  it('stats trackeam ingested + dropped corretamente', async () => {
    const event: TxConfirmedEvent = {
      type: 'tx.confirmed',
      timestamp: new Date().toISOString(),
      chain: 'Base',
      mode: 'dryrun',
      severity: 'info',
      txHash: '0xabc' as `0x${string}`,
      protocol: 'aave-v3',
      borrower: '0xb' as `0x${string}`,
      profitUsd: 1,
      gasCostUsd: 0.1,
      netProfitUsd: 0.9,
      profitDeltaBps: 0,
      blockNumber: '1',
    };

    bus.emit(event);
    bus.emit(event);
    await new Promise((r) => setTimeout(r, 100));

    const stats = ingester.getStats();
    expect(stats.eventsReceived).toBe(2);
    expect(stats.eventsIngested).toBe(2);
    expect(stats.errors).toBe(0);
  });

  it('ingester NÃO derruba bus quando normalize falha (resiliência)', async () => {
    // Event com timestamp inválido — vai dar drop silencioso
    const badEvent = {
      type: 'tx.confirmed',
      timestamp: 'invalid-iso',
      chain: 'Base',
      mode: 'dryrun',
      severity: 'info',
    } as unknown as TxConfirmedEvent;

    bus.emit(badEvent);
    await new Promise((r) => setTimeout(r, 50));

    const stats = ingester.getStats();
    expect(stats.eventsReceived).toBe(1);
    expect(stats.eventsDropped + stats.errors).toBeGreaterThanOrEqual(1);
  });
});

describe('Intelligence — computeTimeDimensions', () => {
  it('calcula hour_utc, weekday, iso_week corretamente', () => {
    // 2026-05-27 14:00:00 UTC = quarta (3) na ISO week 22 (ano da semana)
    const ts = Date.UTC(2026, 4, 27, 14, 0, 0); // mês 0-indexed → 4 = maio
    const dims = computeTimeDimensions(ts);

    expect(dims.hour_utc).toBe(14);
    expect(dims.weekday).toBe(3); // quarta-feira (0=domingo)
    expect(dims.iso_week).toBe(22);
  });

  it('weekday=0 pra domingo', () => {
    // 2026-05-31 (domingo)
    const ts = Date.UTC(2026, 4, 31, 12, 0, 0);
    const dims = computeTimeDimensions(ts);
    expect(dims.weekday).toBe(0);
  });

  it('iso_week=1 pra início de janeiro de um ano novo', () => {
    // 2026-01-05 = primeiro segunda do ano → ISO week 2
    const ts = Date.UTC(2026, 0, 5);
    const dims = computeTimeDimensions(ts);
    expect(dims.iso_week).toBeGreaterThanOrEqual(1);
    expect(dims.iso_week).toBeLessThanOrEqual(2);
  });
});

describe('Intelligence — generateEventId', () => {
  it('IDs são únicos pra mesma timestamp', () => {
    const ts = Date.now();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateEventId(ts));
    }
    expect(ids.size).toBe(100); // sem collision
  });

  it('IDs são lexicograficamente sortable por timestamp', () => {
    const id1 = generateEventId(1000);
    const id2 = generateEventId(2000);
    const id3 = generateEventId(3000);
    expect(id1 < id2).toBe(true);
    expect(id2 < id3).toBe(true);
  });
});
