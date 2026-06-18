/**
 * Núcleo testável do relatório de observação (OIE Etapa D). Separado do CLI pra
 * poder testar sem rodar `main()` no import.
 *
 * Abre/fecha cada ledger SEQUENCIALMENTE (sem opens concorrentes) — evita lock de
 * arquivo do DuckDB (single-writer) e funciona cross-platform.
 */

import { TimeseriesStore } from '../intelligence/timeseriesStore';
import {
  attachAndRankPairs,
  queryTopOpportunityPairs,
  type TopPairRow,
} from '../intelligence/observation';
import { queryDimensionStats } from '../scoring/dimensionStatsQuery';
import {
  rankDimension,
  formatDimensionRankingMarkdown,
  type Dimension,
  type DimensionScore,
} from '../scoring/dimensionScorer';

export const REPORT_DIMENSIONS: Dimension[] = ['protocol', 'pool', 'token'];

export interface ReportSource {
  label: string;
  /** Path do arquivo .duckdb a ler (idealmente uma cópia, não o arquivo ativo). */
  dbPath: string;
}

export interface ReportOpts {
  windowMs: number;
  chain?: string;
}

export interface ObservationReport {
  windowMs: number;
  chain?: string;
  pairs: TopPairRow[];
  dimensions: Record<string, Record<Dimension, DimensionScore[]>>;
}

/** Coleta o relatório a partir dos paths dos ledgers. Abre/fecha cada um internamente. */
export async function collectReport(sources: ReportSource[], opts: ReportOpts): Promise<ObservationReport> {
  if (sources.length === 0) {
    return { windowMs: opts.windowMs, chain: opts.chain, pairs: [], dimensions: {} };
  }

  // ── Dimensões: 1 store por vez (abre → consulta → fecha) ──
  const dimensions: Record<string, Record<Dimension, DimensionScore[]>> = {};
  for (const { label, dbPath } of sources) {
    const store = new TimeseriesStore({ dbPath });
    await store.init();
    try {
      const perDim = {} as Record<Dimension, DimensionScore[]>;
      for (const dim of REPORT_DIMENSIONS) {
        const stats = await queryDimensionStats(store, dim, opts);
        perDim[dim] = rankDimension(dim, stats, { windowMs: opts.windowMs });
      }
      dimensions[label] = perDim;
    } finally {
      await store.shutdown();
    }
  }

  // ── Pares: abre só o primário e ATTACH dos outros paths (que NÃO estão abertos) ──
  const primary = new TimeseriesStore({ dbPath: sources[0]!.dbPath });
  await primary.init();
  let pairs: TopPairRow[];
  try {
    const attachPaths = sources.slice(1).map((s) => s.dbPath);
    pairs = sources.length > 1
      ? await attachAndRankPairs(primary, attachPaths, opts)
      : await queryTopOpportunityPairs(primary, opts);
  } finally {
    await primary.shutdown();
  }

  return { windowMs: opts.windowMs, chain: opts.chain, pairs, dimensions };
}

export function formatPairsMarkdown(rows: TopPairRow[]): string {
  if (rows.length === 0) return '_Sem pares observados na janela._';
  const lines = [
    '## 🎯 Pares observados (ranking)',
    '',
    '| # | Par | Motor | Obs | $/obs | $ total | Persist (h) |',
    '|---|-----|-------|-----|-------|---------|-------------|',
  ];
  rows.slice(0, 25).forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.pair} | ${r.protocol ?? '-'} | ${r.observations} | ` +
      `$${r.avg_profit_usd.toFixed(2)} | $${r.total_profit_usd.toFixed(2)} | ${r.active_hours} |`,
    );
  });
  return lines.join('\n');
}

/** Renderiza o relatório em Markdown. */
export function renderMarkdown(report: ObservationReport, labels: string[]): string {
  const out: string[] = [];
  out.push('# Relatório de observação — DRY_RUN');
  out.push(`> janela ${report.windowMs / (24 * 3600_000)}d${report.chain ? ` · chain ${report.chain}` : ''} · motores: ${labels.join(', ')}`);
  out.push('');
  out.push(formatPairsMarkdown(report.pairs));
  for (const label of labels) {
    out.push('');
    out.push(`---\n### Motor: ${label}`);
    for (const dim of REPORT_DIMENSIONS) {
      out.push('');
      out.push(formatDimensionRankingMarkdown(dim, report.dimensions[label]![dim]));
    }
  }
  return out.join('\n');
}
