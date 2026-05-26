/**
 * CLI dedicado pra rodar backtest histórico sobre os reports salvos.
 * Roda standalone — não precisa scrape novo.
 *
 * Uso:
 *   pnpm backtest
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger';
import { loadConfig } from './config';
import { runBacktest } from './analysis/backtest';

function main(): void {
  const env = loadConfig();
  const report = runBacktest(env.SCRAPER_REPORTS_DIR, logger);

  // Salva snapshot
  const outDir = env.SCRAPER_REPORTS_DIR;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'backtest-latest.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  logger.info(
    {
      entries: report.entries.length,
      reportsAnalyzed: report.reportsAnalyzed,
      keep: report.entries.filter((e) => e.recommendation === 'KEEP').length,
      watch: report.entries.filter((e) => e.recommendation === 'WATCH').length,
      demote: report.entries.filter((e) => e.recommendation === 'DEMOTE').length,
    },
    `🏁 Backtest concluído — salvo em ${outPath}`,
  );
}

main();
