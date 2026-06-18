/**
 * Teste do computeAdaptiveThresholds (OIE Etapa C — auto-ajuste por observação).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TimeseriesStore, buildObservationEvent } from '../src/intelligence';
import { computeAdaptiveThresholds } from '../src/scoring';

describe('computeAdaptiveThresholds', () => {
  let store: TimeseriesStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `zeus-adapt-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.duckdb`);
    store = new TimeseriesStore({ dbPath, batchSize: 1000 });
    await store.init();
  });
  afterEach(async () => {
    await store.shutdown();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}.wal`)) rmSync(`${dbPath}.wal`);
  });

  it('respeita os pisos quando não há observação', async () => {
    const t = await computeAdaptiveThresholds({ store, chain: 'Base', windowMs: 24 * 3600_000 });
    expect(t.MIN_OPPORTUNITY_EV_USD).toBe(0.5); // piso default
    expect(t.MIN_PROFIT_USD).toBe(1);           // piso default
    expect(t.topProtocol).toBeNull();
    expect(t.sources.pairsSeen).toBe(0);
  });

  it('escala com o lucro observado (acima do piso)', async () => {
    // pares com avg ~$20 → MIN_EV = 20*0.35 = 7; MIN_PROFIT = 20*0.6 = 12
    for (let i = 0; i < 5; i++) {
      store.ingest(buildObservationEvent({ chain: 'Base', category: 'arb_observed', protocol: 'arb', pair: 'AERO/USDC', profit_usd: 20 }));
    }
    await store.flush();

    const t = await computeAdaptiveThresholds({ store, chain: 'Base', windowMs: 24 * 3600_000 });
    expect(t.sources.avgObservedProfitUsd).toBeCloseTo(20, 1);
    expect(t.MIN_OPPORTUNITY_EV_USD).toBeCloseTo(7, 1);
    expect(t.MIN_PROFIT_USD).toBeCloseTo(12, 1);
  });

  it('elege o protocolo de maior score como topProtocol', async () => {
    // morpho: muito lucro + sem falha; aave: pouco lucro
    for (let i = 0; i < 10; i++) {
      store.ingest(buildObservationEvent({ chain: 'Base', category: 'liquidation', protocol: 'morpho-blue', pair: 'cbBTC/USDC', profit_usd: 40 }));
    }
    for (let i = 0; i < 10; i++) {
      store.ingest(buildObservationEvent({ chain: 'Base', category: 'liquidation', protocol: 'aave-v3', pair: 'WETH/USDC', profit_usd: 2 }));
    }
    await store.flush();

    const t = await computeAdaptiveThresholds({ store, chain: 'Base', windowMs: 24 * 3600_000 });
    expect(t.topProtocol).toBe('morpho-blue');
    expect(t.sources.protocolRank[0]).toBe('morpho-blue');
  });

  it('pisos customizados são respeitados', async () => {
    const t = await computeAdaptiveThresholds({
      store, chain: 'Base', windowMs: 24 * 3600_000,
      minEvFloorUsd: 3, minProfitFloorUsd: 5,
    });
    expect(t.MIN_OPPORTUNITY_EV_USD).toBe(3);
    expect(t.MIN_PROFIT_USD).toBe(5);
  });
});
