/**
 * dimensionStatsQuery — agrega o histórico do DuckDB (`events` table) em `DimensionStats`.
 *
 * Ponte entre o TimeseriesStore (Item 15) e o DimensionScorer (OIE Fases 2-3). NÃO cria
 * coleta nova: lê o que o EventIngester já grava e produz agregados por protocol/pool/token.
 *
 * O builder de SQL é puro (testável como string); o runner executa via `store.query`.
 */

import type { TimeseriesStore } from '../intelligence/timeseriesStore';
import type { Dimension, DimensionStats } from './dimensionScorer';

/** Categorias que contam como op confirmada (profit realizado). */
export const SUCCESS_CATEGORIES = ['liquidation', 'backrun', 'arb'] as const;
/** Categorias que contam como falha on-chain. */
export const FAILED_CATEGORIES = ['tx_reverted'] as const;

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface DimensionStatsQueryOpts {
  /** Janela de agregação em ms. Default 7 dias. */
  windowMs?: number;
  /** Filtra por chain (ex.: 'Base'). Omitir agrega todas as chains. */
  chain?: string;
  /**
   * Categorias que contam como "valor" (profit + successful_ops). Default = `SUCCESS_CATEGORIES`
   * (execução). Pra ler OBSERVAÇÃO do DRY_RUN, passe `OBSERVATION_VALUE_CATEGORIES`.
   */
  valueCategories?: readonly string[];
}

/** Linha crua retornada pelo DuckDB. */
interface RawRow {
  key: string;
  total_ops: bigint | number;
  successful_ops: bigint | number;
  failed_ops: bigint | number;
  net_profit_usd: number | null;
  unique_competitors: bigint | number;
  avg_amount_usd: number | null;
  active_hours: bigint | number;
}

function n(v: bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Escapa string pra literal SQL (dobra aspas simples). */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const FAILED_IN = `(${FAILED_CATEGORIES.map(sqlStr).join(',')})`;

/**
 * Categorias que carregam VALOR observado no DRY_RUN (sem execução real). Os callers de
 * observação (exporter/adaptive/relatório) passam isto como `valueCategories` pra o profit
 * e a contagem refletirem o que foi OBSERVADO — não só o que foi executado. Sem isto, no
 * DRY_RUN o net_profit/successful ficam 0 (só há arb_observed/mis_observed).
 * Nota: aqui `win_rate` (successful/(successful+failed)) vira "share observado" (sem falhas).
 */
export const OBSERVATION_VALUE_CATEGORIES = [
  'arb_observed', 'mis_observed', 'opportunity_found', ...SUCCESS_CATEGORIES,
] as const;

/** Monta o predicado `IN (...)` das categorias de valor (default = execução). */
function successIn(valueCategories?: readonly string[]): string {
  const list = valueCategories && valueCategories.length > 0 ? valueCategories : SUCCESS_CATEGORIES;
  return `(${list.map(sqlStr).join(',')})`;
}

/** Colunas agregadas comuns às 3 dimensões (filtro de valor parametrizado). */
function aggColumns(sIn: string): string {
  return `
  COUNT(*) AS total_ops,
  COUNT(*) FILTER (WHERE category IN ${sIn}) AS successful_ops,
  COUNT(*) FILTER (WHERE category IN ${FAILED_IN}) AS failed_ops,
  COALESCE(SUM(profit_usd) FILTER (WHERE category IN ${sIn}), 0)
    - COALESCE(SUM(gas_usd) FILTER (WHERE category IN ${sIn}), 0) AS net_profit_usd,
  COUNT(DISTINCT sender) AS unique_competitors,
  AVG(amount_usd) AS avg_amount_usd,
  COUNT(DISTINCT hour_utc) AS active_hours`;
}

/**
 * Monta o SQL de agregação por dimensão. Puro — testável sem DuckDB.
 *
 * - protocol/pool: GROUP BY na coluna (`protocol` / `pair`).
 * - token: explode `pair` ('USDC/WETH') em 2 linhas via split_part e agrega por token.
 */
export function buildDimensionStatsSql(
  dimension: Dimension,
  sinceTimestamp: number,
  chain?: string,
  valueCategories?: readonly string[],
): string {
  const chainFilter = chain ? ` AND chain = ${sqlStr(chain)}` : '';
  const cols = aggColumns(successIn(valueCategories));

  if (dimension === 'token') {
    // Explode o par em tokens individuais, depois agrega.
    return `
SELECT token AS key,${cols}
FROM (
  SELECT split_part(pair, '/', 1) AS token, category, profit_usd, gas_usd, sender, amount_usd, hour_utc, chain, timestamp
    FROM events WHERE pair IS NOT NULL
  UNION ALL
  SELECT split_part(pair, '/', 2) AS token, category, profit_usd, gas_usd, sender, amount_usd, hour_utc, chain, timestamp
    FROM events WHERE pair IS NOT NULL
) t
WHERE token IS NOT NULL AND token <> '' AND timestamp >= ${sinceTimestamp}${chainFilter}
GROUP BY token
ORDER BY total_ops DESC`.trim();
  }

  const col = dimension === 'protocol' ? 'protocol' : 'pair';
  return `
SELECT ${col} AS key,${cols}
FROM events
WHERE ${col} IS NOT NULL AND timestamp >= ${sinceTimestamp}${chainFilter}
GROUP BY ${col}
ORDER BY total_ops DESC`.trim();
}

/**
 * Executa a agregação no DuckDB e devolve `DimensionStats[]` pronto pro DimensionScorer.
 */
export async function queryDimensionStats(
  store: TimeseriesStore,
  dimension: Dimension,
  opts: DimensionStatsQueryOpts = {},
): Promise<DimensionStats[]> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const sinceTimestamp = Date.now() - windowMs;
  const sql = buildDimensionStatsSql(dimension, sinceTimestamp, opts.chain, opts.valueCategories);

  const rows = await store.query<RawRow>(sql);

  return rows.map((r) => ({
    key: r.key,
    total_ops: n(r.total_ops),
    successful_ops: n(r.successful_ops),
    failed_ops: n(r.failed_ops),
    net_profit_usd: n(r.net_profit_usd),
    unique_competitors: n(r.unique_competitors),
    avg_amount_usd: r.avg_amount_usd === null ? undefined : n(r.avg_amount_usd),
    active_hours: n(r.active_hours),
  }));
}
