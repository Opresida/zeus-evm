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
import { queryDimensionStats, OBSERVATION_VALUE_CATEGORIES } from '../scoring/dimensionStatsQuery';
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
  /** Contagem de eventos por categoria (toda a inteligência capturada na janela). */
  categoryCounts: Record<string, number>;
}

/** Conta eventos por categoria num store (toda a inteligência: órfãos incluídos). */
async function queryCategoryCounts(
  store: TimeseriesStore,
  windowMs: number,
  chain?: string,
): Promise<Record<string, number>> {
  const since = Date.now() - windowMs;
  const chainFilter = chain ? ` AND chain = '${chain.replace(/'/g, "''")}'` : '';
  const rows = await store.query<{ category: string; n: number | bigint }>(
    `SELECT category, COUNT(*) AS n FROM events WHERE timestamp >= ${since}${chainFilter} GROUP BY category`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.category)] = typeof r.n === 'bigint' ? Number(r.n) : r.n;
  return out;
}

/** Coleta o relatório a partir dos paths dos ledgers. Abre/fecha cada um internamente. */
export async function collectReport(sources: ReportSource[], opts: ReportOpts): Promise<ObservationReport> {
  if (sources.length === 0) {
    return { windowMs: opts.windowMs, chain: opts.chain, pairs: [], dimensions: {}, categoryCounts: {} };
  }

  // ── Dimensões + contagem por categoria: 1 store por vez (abre → consulta → fecha) ──
  const dimensions: Record<string, Record<Dimension, DimensionScore[]>> = {};
  const categoryCounts: Record<string, number> = {};
  for (const { label, dbPath } of sources) {
    const store = new TimeseriesStore({ dbPath });
    await store.init();
    try {
      const perDim = {} as Record<Dimension, DimensionScore[]>;
      for (const dim of REPORT_DIMENSIONS) {
        // valueCategories de observação → profit/score refletem o que foi observado (DRY_RUN).
        const stats = await queryDimensionStats(store, dim, { ...opts, valueCategories: OBSERVATION_VALUE_CATEGORIES });
        perDim[dim] = rankDimension(dim, stats, { windowMs: opts.windowMs });
      }
      dimensions[label] = perDim;
      // Soma as contagens por categoria de todos os ledgers (visão unificada do que foi capturado).
      const counts = await queryCategoryCounts(store, opts.windowMs, opts.chain);
      for (const [cat, n] of Object.entries(counts)) categoryCounts[cat] = (categoryCounts[cat] ?? 0) + n;
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

  return { windowMs: opts.windowMs, chain: opts.chain, pairs, dimensions, categoryCounts };
}

/** Tabela "inteligência capturada por categoria" — responde "está tudo sendo gravado?". */
export function formatCategoryCountsMarkdown(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '_Nenhum evento capturado na janela._';
  const lines = [
    '## 🧠 Inteligência capturada (por categoria)',
    '',
    '| Categoria | Eventos |',
    '|-----------|---------|',
  ];
  for (const [cat, n] of entries) lines.push(`| ${cat} | ${n} |`);
  return lines.join('\n');
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
  out.push(formatCategoryCountsMarkdown(report.categoryCounts));
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
