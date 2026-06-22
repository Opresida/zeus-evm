/**
 * Fase 3/4 — EventIngester mapeia os eventos novos pro ledger central.
 *
 * Valida o caminho REAL: ZeusEvent emitido no EventBus → EventIngester normaliza →
 * TimeseriesStore grava com a categoria certa.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../src/eventBus';
import { TimeseriesStore, EventIngester } from '../src/intelligence';

function freshDb(tag: string): string {
  return join(tmpdir(), `zeus-ing-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.duckdb`);
}
function cleanup(path: string): void {
  if (existsSync(path)) rmSync(path);
  if (existsSync(`${path}.wal`)) rmSync(`${path}.wal`);
}

describe('EventIngester — eventos órfãos mapeados (Fase 3/4)', () => {
  let store: TimeseriesStore;
  let bus: EventBus;
  let ingester: EventIngester;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = freshDb('orphan');
    store = new TimeseriesStore({ dbPath, batchSize: 1000, flushIntervalMs: 100 });
    await store.init();
    bus = new EventBus();
    ingester = new EventIngester({ store, eventBus: bus, defaultChain: 'Base' });
    ingester.start();
  });
  afterEach(async () => {
    await ingester.stop();
    await store.shutdown();
    cleanup(dbPath);
  });

  it('pnl.reconciled → categoria pnl_reconciled com drift + gas', async () => {
    bus.emit({
      type: 'pnl.reconciled',
      timestamp: new Date().toISOString(),
      chain: 'Base',
      mode: 'dryrun',
      severity: 'info',
      protocol: 'morpho-blue',
      txHash: '0xabc',
      blockNumber: '12345',
      expectedNetUsd: 10,
      realizedNetUsd: 8.5,
      profitDeltaBps: -1500,
      gasUsd: 0.42,
      attributionCause: 'pool_slippage',
    });
    await store.flush();
    const rows = await store.query<{ category: string; profit_usd: number; gas_usd: number; profit_delta_bps: number }>(
      "SELECT category, profit_usd, gas_usd, profit_delta_bps FROM events WHERE category = 'pnl_reconciled'",
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.profit_usd)).toBeCloseTo(8.5, 5);
    expect(Number(rows[0]!.gas_usd)).toBeCloseTo(0.42, 5);
    expect(Number(rows[0]!.profit_delta_bps)).toBe(-1500);
  });

  it('failure.recorded → categoria failure_recorded com a categoria de falha no payload', async () => {
    bus.emit({
      type: 'failure.recorded',
      timestamp: new Date().toISOString(),
      chain: 'Base',
      mode: 'dryrun',
      severity: 'warn',
      protocol: 'aave-v3',
      failureCategory: 'lost_race',
      txHash: '0xdef',
      gasUsdLost: 0.3,
      reason: 'outbid',
    });
    await store.flush();
    const rows = await store.query<{ category: string; payload: string; gas_usd: number }>(
      "SELECT category, payload, gas_usd FROM events WHERE category = 'failure_recorded'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toContain('lost_race');
    expect(Number(rows[0]!.gas_usd)).toBeCloseTo(0.3, 5);
  });
});
