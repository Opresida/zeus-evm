/**
 * Observation helpers — DRY_RUN intelligence (Etapa B do OIE).
 *
 * Motores de OBSERVAÇÃO (detector de arb, MIS scanner) gravam o que veem no mundo real
 * no TimeseriesStore (DuckDB) pra responder empiricamente "quais pares têm o melhor edge".
 *
 * ⚠️ DuckDB é single-writer: cada motor escreve no SEU arquivo `.duckdb`. A unificação
 * cross-motor acontece na CONSULTA (DuckDB `ATTACH` + UNION) — ver `attachAndRankPairs`.
 */

import { resolve } from 'node:path';

import type { TimeseriesStore } from './timeseriesStore';
import {
  computeTimeDimensions,
  generateEventId,
  type HistoricalEvent,
  type EventCategory,
  type EventMode,
  type EventSeverity,
} from './intelligenceSchema';

/**
 * Resolve o path do arquivo DuckDB. Honra `INTELLIGENCE_DB_PATH` (full path, usado no
 * deploy pra apontar pro volume persistente da Fly.io); senão usa `logs/<defaultBaseName>`.
 * Cada app passa um basename distinto pra evitar colisão de lock se co-localizados.
 */
export function resolveIntelligenceDbPath(defaultBaseName = 'intelligence.duckdb'): string {
  const fromEnv = process.env['INTELLIGENCE_DB_PATH'];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return resolve('logs', defaultBaseName);
}

export interface ObservationInput {
  chain: string;
  category: EventCategory;
  timestamp?: number;
  mode?: EventMode;
  severity?: EventSeverity;
  protocol?: string;
  pair?: string;
  sender?: string;
  borrower?: string;
  amount_usd?: number;
  profit_usd?: number;
  gas_usd?: number;
  slippage_bps?: number;
  profit_delta_bps?: number;
  payload?: Record<string, unknown>;
}

/**
 * Monta um `HistoricalEvent` a partir de uma observação (preenche id + dimensões temporais).
 * Usar com `store.ingest(buildObservationEvent({...}))`.
 */
export function buildObservationEvent(input: ObservationInput): HistoricalEvent {
  const timestamp = input.timestamp ?? Date.now();
  const time = computeTimeDimensions(timestamp);
  return {
    id: generateEventId(timestamp),
    timestamp,
    source_event_type: 'observation',
    hour_utc: time.hour_utc,
    weekday: time.weekday,
    iso_week: time.iso_week,
    chain: input.chain,
    category: input.category,
    mode: input.mode ?? 'dryrun',
    severity: input.severity ?? 'info',
    protocol: input.protocol,
    pair: input.pair,
    borrower: input.borrower,
    sender: input.sender,
    amount_usd: input.amount_usd,
    profit_usd: input.profit_usd,
    gas_usd: input.gas_usd,
    slippage_bps: input.slippage_bps,
    profit_delta_bps: input.profit_delta_bps,
    payload: input.payload ?? {},
  };
}

export interface TopPairRow {
  pair: string;
  protocol: string | null;
  observations: number;
  avg_profit_usd: number;
  total_profit_usd: number;
  max_profit_usd: number;
  /** Horas distintas com observação — proxy de PERSISTÊNCIA (sinal-chave de edge real). */
  active_hours: number;
}

const OBSERVED_CATEGORIES: EventCategory[] = ['arb_observed', 'mis_observed', 'opportunity_found'];

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function buildRankSql(table: string, sinceTimestamp: number, cats: EventCategory[], chain?: string): string {
  const catList = cats.map(sqlStr).join(',');
  const chainFilter = chain ? ` AND chain = ${sqlStr(chain)}` : '';
  return `
    SELECT pair, protocol,
           COUNT(*) AS observations,
           COALESCE(AVG(profit_usd), 0) AS avg_profit_usd,
           COALESCE(SUM(profit_usd), 0) AS total_profit_usd,
           COALESCE(MAX(profit_usd), 0) AS max_profit_usd,
           COUNT(DISTINCT hour_utc) AS active_hours
    FROM ${table}
    WHERE pair IS NOT NULL AND category IN (${catList}) AND timestamp >= ${sinceTimestamp}${chainFilter}
    GROUP BY pair, protocol`;
}

function mapRow(r: Record<string, unknown>): TopPairRow {
  const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
  return {
    pair: String(r.pair),
    protocol: r.protocol == null ? null : String(r.protocol),
    observations: num(r.observations),
    avg_profit_usd: Math.round(num(r.avg_profit_usd) * 100) / 100,
    total_profit_usd: Math.round(num(r.total_profit_usd) * 100) / 100,
    max_profit_usd: Math.round(num(r.max_profit_usd) * 100) / 100,
    active_hours: num(r.active_hours),
  };
}

export interface TopPairsOpts {
  windowMs?: number;
  chain?: string;
  categories?: EventCategory[];
}

/**
 * Ranqueia pares por oportunidades OBSERVADAS num ÚNICO store (frequência + lucro + persistência).
 * Responde "quais pares têm o melhor edge" a partir do histórico real de um motor.
 */
export async function queryTopOpportunityPairs(
  store: TimeseriesStore,
  opts: TopPairsOpts = {},
): Promise<TopPairRow[]> {
  const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const since = Date.now() - windowMs;
  const cats = opts.categories ?? OBSERVED_CATEGORIES;
  const sql = `${buildRankSql('events', since, cats, opts.chain)} ORDER BY observations DESC`;
  const rows = await store.query<Record<string, unknown>>(sql);
  return rows.map(mapRow);
}

/**
 * Unificação CROSS-MOTOR: faz ATTACH de vários arquivos `.duckdb` (um por motor) e ranqueia
 * os pares somando as observações de todos. É o jeito correto de unificar com DuckDB
 * (single-writer): cada motor tem seu arquivo, a consulta junta tudo.
 *
 * @param primary store já aberto (qualquer um); os demais são anexados por path.
 * @param attachPaths paths dos outros arquivos `.duckdb` a unir.
 */
export async function attachAndRankPairs(
  primary: TimeseriesStore,
  attachPaths: string[],
  opts: TopPairsOpts = {},
): Promise<TopPairRow[]> {
  const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const since = Date.now() - windowMs;
  const cats = opts.categories ?? OBSERVED_CATEGORIES;

  // ATTACH read-only de cada arquivo extra com um alias estável.
  const aliases: string[] = ['main'];
  for (let i = 0; i < attachPaths.length; i++) {
    const alias = `src${i}`;
    await primary.query(`ATTACH IF NOT EXISTS ${sqlStr(attachPaths[i]!)} AS ${alias} (READ_ONLY)`);
    aliases.push(alias);
  }

  // UNION ALL dos eventos de todos os bancos, depois agrega.
  const unionParts = aliases.map((a) =>
    `SELECT pair, protocol, profit_usd, hour_utc, category, timestamp, chain FROM ${a === 'main' ? 'events' : `${a}.events`}`,
  );
  const unionSql = unionParts.join('\n      UNION ALL\n      ');
  const ranked = buildRankSql(`(\n      ${unionSql}\n    ) AS unified`, since, cats, opts.chain);
  const rows = await primary.query<Record<string, unknown>>(`${ranked} ORDER BY observations DESC`);
  return rows.map(mapRow);
}
