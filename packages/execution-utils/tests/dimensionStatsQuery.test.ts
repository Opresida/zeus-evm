/**
 * Testes do dimensionStatsQuery (agregação DuckDB → DimensionStats).
 *
 * - Builder de SQL: asserts de string (puro).
 * - Roundtrip real no DuckDB: ingere eventos e valida agregados + score end-to-end.
 *
 * Não depende de RPC nem fork — roda em qualquer ambiente (igual intelligence.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TimeseriesStore, generateEventId } from '../src/intelligence';
import type { HistoricalEvent, EventCategory } from '../src/intelligence';
import {
  buildDimensionStatsSql,
  queryDimensionStats,
  rankDimension,
  OBSERVATION_VALUE_CATEGORIES,
} from '../src/scoring';

describe('dimensionStatsQuery — SQL builder', () => {
  const SINCE = 1_000_000;

  it('protocol agrupa por protocol e filtra timestamp', () => {
    const sql = buildDimensionStatsSql('protocol', SINCE);
    expect(sql).toContain('SELECT protocol AS key');
    expect(sql).toContain('GROUP BY protocol');
    expect(sql).toContain(`timestamp >= ${SINCE}`);
    expect(sql).not.toContain('chain =');
  });

  it('pool agrupa por pair', () => {
    const sql = buildDimensionStatsSql('pool', SINCE);
    expect(sql).toContain('SELECT pair AS key');
    expect(sql).toContain('GROUP BY pair');
  });

  it('token explode o par via split_part', () => {
    const sql = buildDimensionStatsSql('token', SINCE);
    expect(sql).toContain("split_part(pair, '/', 1)");
    expect(sql).toContain("split_part(pair, '/', 2)");
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('GROUP BY token');
  });

  it('filtro de chain escapa aspas simples', () => {
    const sql = buildDimensionStatsSql('protocol', SINCE, "Ba'se");
    expect(sql).toContain("chain = 'Ba''se'");
  });
});

describe('dimensionStatsQuery — roundtrip DuckDB', () => {
  let store: TimeseriesStore;
  let dbPath: string;

  function dbPathFresh(): string {
    return join(
      tmpdir(),
      `zeus-dimq-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.duckdb`,
    );
  }

  function ingestEvent(over: Partial<HistoricalEvent> & { category: EventCategory }): void {
    const ts = Date.now();
    store.ingest({
      id: generateEventId(ts + Math.random()),
      timestamp: ts,
      source_event_type: 'test',
      hour_utc: new Date(ts).getUTCHours(),
      weekday: 1,
      iso_week: 22,
      chain: 'Base',
      mode: 'dryrun',
      severity: 'info',
      payload: {},
      ...over,
    });
  }

  beforeEach(async () => {
    dbPath = dbPathFresh();
    store = new TimeseriesStore({ dbPath, batchSize: 1000, flushIntervalMs: 100 });
    await store.init();
  });

  afterEach(async () => {
    await store.shutdown();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}.wal`)) rmSync(`${dbPath}.wal`);
  });

  it('agrega protocol: ops, win_rate, net_profit, competidores', async () => {
    // morpho: 5 confirmados ($10 profit, $1 gas cada) + 1 revert, 2 senders distintos
    for (let i = 0; i < 5; i++) {
      ingestEvent({
        category: 'liquidation',
        protocol: 'morpho-blue',
        profit_usd: 10,
        gas_usd: 1,
        amount_usd: 5_000,
        sender: i % 2 === 0 ? '0xAAA' : '0xBBB',
      });
    }
    ingestEvent({ category: 'tx_reverted', protocol: 'morpho-blue', gas_usd: 1, sender: '0xAAA' });

    await store.flush();

    const stats = await queryDimensionStats(store, 'protocol', { windowMs: 24 * 3600 * 1000 });
    const morpho = stats.find((s) => s.key === 'morpho-blue')!;
    expect(morpho.total_ops).toBe(6);
    expect(morpho.successful_ops).toBe(5);
    expect(morpho.failed_ops).toBe(1);
    // net = 5×(10-1) = 45
    expect(morpho.net_profit_usd).toBeCloseTo(45, 5);
    expect(morpho.unique_competitors).toBe(2);
    expect(morpho.avg_amount_usd).toBeCloseTo(5_000, 0);
  });

  it('token explode pares e agrega por símbolo', async () => {
    for (let i = 0; i < 6; i++) {
      ingestEvent({ category: 'arb', pair: 'USDC/WETH', profit_usd: 5, gas_usd: 1, amount_usd: 1000 });
    }
    for (let i = 0; i < 6; i++) {
      ingestEvent({ category: 'arb', pair: 'WETH/DAI', profit_usd: 3, gas_usd: 1, amount_usd: 1000 });
    }

    await store.flush();

    const stats = await queryDimensionStats(store, 'token', { windowMs: 24 * 3600 * 1000 });
    const weth = stats.find((s) => s.key === 'WETH')!;
    // WETH aparece nos 2 pares → 12 ops
    expect(weth.total_ops).toBe(12);
    const usdc = stats.find((s) => s.key === 'USDC')!;
    expect(usdc.total_ops).toBe(6);
  });

  it('pipeline end-to-end: query → rankDimension', async () => {
    for (let i = 0; i < 10; i++) {
      ingestEvent({ category: 'liquidation', protocol: 'morpho-blue', profit_usd: 40, gas_usd: 1, sender: `0x${i}` });
    }
    for (let i = 0; i < 10; i++) {
      ingestEvent({ category: 'liquidation', protocol: 'aave-v3', profit_usd: 2, gas_usd: 1, sender: `0x${i}` });
      ingestEvent({ category: 'tx_reverted', protocol: 'aave-v3', gas_usd: 1 });
    }

    await store.flush();

    const stats = await queryDimensionStats(store, 'protocol', { windowMs: 24 * 3600 * 1000 });
    const ranking = rankDimension('protocol', stats, { windowMs: 24 * 3600 * 1000 });
    expect(ranking[0]!.key).toBe('morpho-blue'); // mais lucrativo + 100% win
  });

  it('filtro de chain isola corretamente', async () => {
    ingestEvent({ category: 'liquidation', protocol: 'aave-v3', chain: 'Base', profit_usd: 10, gas_usd: 1 });
    ingestEvent({ category: 'liquidation', protocol: 'aave-v3', chain: 'Arbitrum', profit_usd: 10, gas_usd: 1 });

    await store.flush();

    const baseStats = await queryDimensionStats(store, 'protocol', {
      windowMs: 24 * 3600 * 1000,
      chain: 'Base',
    });
    const aave = baseStats.find((s) => s.key === 'aave-v3')!;
    expect(aave.total_ops).toBe(1);
  });

  it('valueCategories de observação: arb_observed conta lucro/successful (fix auditoria)', async () => {
    for (let i = 0; i < 4; i++) {
      ingestEvent({ category: 'arb_observed', protocol: 'arb', pair: 'AERO/USDC', profit_usd: 10, gas_usd: 1 });
    }
    await store.flush();

    // Default (execução) → observação NÃO conta: net_profit/successful = 0
    const exec = (await queryDimensionStats(store, 'protocol', { windowMs: 24 * 3600 * 1000 }))
      .find((s) => s.key === 'arb')!;
    expect(exec.total_ops).toBe(4);
    expect(exec.successful_ops).toBe(0);
    expect(exec.net_profit_usd).toBe(0);

    // Com valueCategories de observação → conta: net = 4×(10-1) = 36, successful = 4
    const obs = (await queryDimensionStats(store, 'protocol', {
      windowMs: 24 * 3600 * 1000,
      valueCategories: OBSERVATION_VALUE_CATEGORIES,
    })).find((s) => s.key === 'arb')!;
    expect(obs.successful_ops).toBe(4);
    expect(obs.net_profit_usd).toBeCloseTo(36, 5);
  });
});
