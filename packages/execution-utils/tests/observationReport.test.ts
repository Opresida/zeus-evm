/**
 * Testes do núcleo do relatório de observação (OIE Etapa D).
 * Cria ledgers de fixture, fecha, e roda collectReport/renderMarkdown sobre os arquivos.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TimeseriesStore, buildObservationEvent } from '../src/intelligence';
import type { EventCategory } from '../src/intelligence';
import { collectReport, renderMarkdown } from '../src/cli/observationReportCore';

function freshDb(tag: string): string {
  return join(tmpdir(), `zeus-rep-${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.duckdb`);
}
function cleanup(path: string): void {
  if (existsSync(path)) rmSync(path);
  if (existsSync(`${path}.wal`)) rmSync(`${path}.wal`);
}

/** Cria um ledger de fixture, ingere eventos e FECHA (pra collectReport poder abrir). */
async function seedLedger(
  dbPath: string,
  events: Array<{ category: EventCategory; protocol: string; pair: string; profit: number }>,
): Promise<void> {
  const store = new TimeseriesStore({ dbPath, batchSize: 1000 });
  await store.init();
  for (const e of events) {
    store.ingest(buildObservationEvent({
      chain: 'Base', category: e.category, protocol: e.protocol, pair: e.pair, profit_usd: e.profit,
    }));
  }
  await store.flush();
  await store.shutdown();
}

describe('collectReport — relatório de observação', () => {
  let detPath: string;
  let misPath: string;

  beforeEach(() => {
    detPath = freshDb('det');
    misPath = freshDb('mis');
  });
  afterEach(() => {
    cleanup(detPath);
    cleanup(misPath);
  });

  it('unifica pares de 2 motores + ranqueia dimensões por motor', async () => {
    await seedLedger(detPath, [
      { category: 'arb_observed', protocol: 'arb', pair: 'AERO/USDC', profit: 3 },
      { category: 'arb_observed', protocol: 'arb', pair: 'AERO/USDC', profit: 3 },
      { category: 'arb_observed', protocol: 'arb', pair: 'VIRTUAL/WETH', profit: 1 },
    ]);
    await seedLedger(misPath, [
      { category: 'mis_observed', protocol: 'mis', pair: 'AERO/USDC', profit: 5 },
      { category: 'mis_observed', protocol: 'mis', pair: 'AERO/USDC', profit: 5 },
    ]);

    const report = await collectReport(
      [{ label: 'det', dbPath: detPath }, { label: 'mis', dbPath: misPath }],
      { windowMs: 24 * 3600_000, chain: 'Base' },
    );

    // Pares unificados: AERO/USDC tem 2 (arb) + 2 (mis) = 4 observações no total
    const aeroTotal = report.pairs
      .filter((p) => p.pair === 'AERO/USDC')
      .reduce((s, p) => s + p.observations, 0);
    expect(aeroTotal).toBe(4);

    // Dimensões por motor presentes
    expect(report.dimensions.det).toBeDefined();
    expect(report.dimensions.mis).toBeDefined();
    expect(Array.isArray(report.dimensions.det!.protocol)).toBe(true);
  });

  it('renderMarkdown produz tabela de pares + seções por motor', async () => {
    await seedLedger(detPath, [
      { category: 'arb_observed', protocol: 'arb', pair: 'AERO/USDC', profit: 4 },
    ]);
    const report = await collectReport([{ label: 'det', dbPath: detPath }], { windowMs: 24 * 3600_000 });
    const md = renderMarkdown(report, ['det']);
    expect(md).toContain('Relatório de observação');
    expect(md).toContain('Pares observados');
    expect(md).toContain('AERO/USDC');
    expect(md).toContain('Motor: det');
  });

  it('conta a inteligência por categoria (órfãos incluídos) + mostra no markdown', async () => {
    await seedLedger(detPath, [
      { category: 'arb_observed', protocol: 'arb', pair: 'A/B', profit: 1 },
      { category: 'market_bribe', protocol: 'bribe', pair: 'MARKET', profit: 0 },
      { category: 'competitor', protocol: 'aggregate', pair: 'X', profit: 0 },
      { category: 'pnl_reconciled', protocol: 'morpho-blue', pair: 'Y', profit: 0 },
      { category: 'failure_recorded', protocol: 'aave-v3', pair: 'Z', profit: 0 },
    ]);
    const report = await collectReport([{ label: 'det', dbPath: detPath }], { windowMs: 24 * 3600_000 });
    expect(report.categoryCounts['market_bribe']).toBe(1);
    expect(report.categoryCounts['competitor']).toBe(1);
    expect(report.categoryCounts['pnl_reconciled']).toBe(1);
    expect(report.categoryCounts['failure_recorded']).toBe(1);
    const md = renderMarkdown(report, ['det']);
    expect(md).toContain('Inteligência capturada (por categoria)');
    expect(md).toContain('market_bribe');
  });

  it('1 motor só usa queryTopOpportunityPairs (sem ATTACH)', async () => {
    await seedLedger(detPath, [
      { category: 'arb_observed', protocol: 'arb', pair: 'X/Y', profit: 2 },
      { category: 'arb_observed', protocol: 'arb', pair: 'X/Y', profit: 2 },
    ]);
    const report = await collectReport([{ label: 'det', dbPath: detPath }], { windowMs: 24 * 3600_000 });
    expect(report.pairs[0]!.pair).toBe('X/Y');
    expect(report.pairs[0]!.observations).toBe(2);
  });
});
