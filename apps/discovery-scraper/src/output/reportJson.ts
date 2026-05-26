/**
 * JSON report dump — salva snapshot completo em disco.
 *
 * Cada run gera 2 arquivos:
 *   - reports/latest.json (sobrescrito a cada run)
 *   - reports/YYYY-MM-DD_HH-MM.json (histórico, append-only)
 *
 * Histórico é matéria-prima pro Sprint 4 (backtest) — comparar candidates
 * sugeridos vs profit observado real ao longo do tempo.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { ScraperReport } from './types';

export interface JsonReportOpts {
  /** Pasta de output. Default ./reports/ */
  reportsDir: string;
  logger?: LoggerLike;
}

export function writeJsonReport(report: ScraperReport, opts: JsonReportOpts): void {
  const { reportsDir, logger } = opts;

  const dir = resolve(process.cwd(), reportsDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // latest.json
  const latestPath = resolve(dir, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(report, null, 2));

  // histórico timestampado
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const historyPath = resolve(dir, `${ts}.json`);
  writeFileSync(historyPath, JSON.stringify(report, null, 2));

  logger?.info(
    {
      latestPath,
      historyPath,
      chains: report.results.length,
    },
    `💾 Relatório JSON salvo em ${reportsDir}/`,
  );
}
