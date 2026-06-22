/**
 * Teste do DimensionMetricsExporter (bridge DuckDB → Prometheus, OIE Etapa D pt.2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TimeseriesStore, buildObservationEvent } from '../src/intelligence';
import { MetricRegistry } from '../src/observability';
import { DimensionMetricsExporter } from '../src/observability/dimensionMetricsExporter';

describe('DimensionMetricsExporter', () => {
  let store: TimeseriesStore;
  let dbPath: string;
  let registry: MetricRegistry;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `zeus-dme-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.duckdb`);
    store = new TimeseriesStore({ dbPath, batchSize: 1000 });
    await store.init();
    registry = new MetricRegistry();
  });
  afterEach(async () => {
    await store.shutdown();
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(`${dbPath}.wal`)) rmSync(`${dbPath}.wal`);
  });

  it('seta métricas de par + dimensão no registry a partir do ledger', async () => {
    for (let i = 0; i < 6; i++) {
      store.ingest(buildObservationEvent({
        chain: 'Base', category: 'arb_observed', protocol: 'arb', pair: 'AERO/USDC', profit_usd: 4,
      }));
    }
    await store.flush();

    const exporter = new DimensionMetricsExporter({ registry, store, chain: 'Base', windowMs: 24 * 3600_000 });
    await exporter.updateOnce();

    const out = registry.render();
    // Métricas de par
    expect(out).toContain('zeus_pair_observations');
    expect(out).toContain('pair="AERO/USDC"');
    expect(out).toMatch(/zeus_pair_observations\{[^}]*pair="AERO\/USDC"[^}]*\}\s+6/);
    // Métricas de dimensão (token explode o par → AERO e USDC aparecem)
    expect(out).toContain('zeus_dim_score');
    expect(out).toContain('dimension="protocol"');
  });

  it('re-set não duplica a série (idempotente por label-set)', async () => {
    store.ingest(buildObservationEvent({ chain: 'Base', category: 'arb_observed', protocol: 'arb', pair: 'X/Y', profit_usd: 1 }));
    await store.flush();

    const exporter = new DimensionMetricsExporter({ registry, store, chain: 'Base', windowMs: 24 * 3600_000 });
    await exporter.updateOnce();
    await exporter.updateOnce();

    const out = registry.render();
    const matches = out.match(/zeus_pair_observations\{[^}]*pair="X\/Y"[^}]*\}/g) ?? [];
    expect(matches.length).toBe(1); // não duplicou
  });

  it('respeita o top-N (não explode cardinalidade)', async () => {
    for (let i = 0; i < 6; i++) {
      store.ingest(buildObservationEvent({
        chain: 'Base', category: 'arb_observed', protocol: 'arb', pair: `T${i}/USDC`, profit_usd: i + 1,
      }));
    }
    await store.flush();

    const exporter = new DimensionMetricsExporter({ registry, store, chain: 'Base', windowMs: 24 * 3600_000, topN: 2 });
    await exporter.updateOnce();

    const out = registry.render();
    const pairSeries = out.match(/^zeus_pair_observations\{/gm) ?? [];
    expect(pairSeries.length).toBeLessThanOrEqual(2);
  });
});
