/**
 * observationReport — CLI do relatório do DRY_RUN (OIE Etapa D, parte 1).
 *
 * Lê o(s) ledger(s) DuckDB (detector/MIS/liquidator) e imprime o ranking de pares +
 * protocol/pool/token. ZERO infra — responde "quais pares têm edge" no terminal.
 *
 * Como os apps seguram o arquivo (DuckDB single-writer), COPIA cada `.duckdb` (+ `.wal`)
 * pra um temp e lê a cópia — funciona com o bot rodando.
 *
 *   tsx src/cli/observationReport.ts --db-paths logs/intelligence-detector.duckdb,logs/intelligence-mis.duckdb \
 *       --window-days 7 --chain Base --output markdown
 */

import { existsSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { collectReport, renderMarkdown, type ReportSource } from './observationReportCore';

interface Args {
  dbPaths: string[];
  windowMs: number;
  chain?: string;
  output: 'markdown' | 'json';
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const dbPaths = (get('--db-paths') ?? 'logs/intelligence.duckdb')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const windowDays = Number(get('--window-days') ?? 7);
  const output = get('--output') === 'json' ? 'json' : 'markdown';
  const chain = get('--chain');
  return { dbPaths, windowMs: windowDays * 24 * 60 * 60 * 1000, chain, output };
}

/** Copia o db (+ wal) pra um temp e devolve o source (evita lock do app rodando). */
function snapshotSource(dbPath: string, tmpDir: string): ReportSource | null {
  if (!existsSync(dbPath)) {
    process.stderr.write(`⚠️  ledger não encontrado: ${dbPath} (pulando)\n`);
    return null;
  }
  const copyPath = join(tmpDir, basename(dbPath));
  copyFileSync(dbPath, copyPath);
  if (existsSync(`${dbPath}.wal`)) copyFileSync(`${dbPath}.wal`, `${copyPath}.wal`);
  return { label: basename(dbPath), dbPath: copyPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tmpDir = mkdtempSync(join(tmpdir(), 'zeus-report-'));

  try {
    const sources = args.dbPaths
      .map((p) => snapshotSource(p, tmpDir))
      .filter((s): s is ReportSource => s !== null);

    if (sources.length === 0) {
      process.stderr.write('Nenhum ledger válido pra ler. Use --db-paths.\n');
      process.exitCode = 1;
      return;
    }

    const report = await collectReport(sources, { windowMs: args.windowMs, chain: args.chain });

    if (args.output === 'json') {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(renderMarkdown(report, sources.map((s) => s.label)) + '\n');
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`observationReport falhou: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
