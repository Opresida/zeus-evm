/**
 * Schema canonical pra Historical Intelligence — Item 15 do checklist.
 *
 * **Por que esse schema importa:** alimenta IA futura do ZEUS (Item 16A) com
 * dataset estruturado. Cada decisão tomada vira feature pra training. Dados
 * que não foram coletados NUNCA podem ser recuperados.
 *
 * Schema ML-friendly:
 *  - Numericals normalizados (amount_usd, profit_usd, slippage_bps)
 *  - Categoricals discretos (chain, category, protocol)
 *  - Time-series com dimensões temporais pré-computadas (hour_utc, weekday)
 *  - Payload JSON pra dados raw sem perder informação
 *
 * Storage: DuckDB embedded (columnar, sem servidor, ~zero overhead).
 */

/**
 * Categorias canônicas de eventos coletados.
 * Cada ZeusEvent é mapeado pra uma categoria pelo eventIngester.
 */
export type EventCategory =
  | 'liquidation'           // tx.confirmed onde profit veio de liquidation
  | 'backrun'               // tx.confirmed onde profit veio de backrun
  | 'arb'                   // tx.confirmed cross-DEX arb
  | 'tx_reverted'           // tx submetida reverteu on-chain
  | 'pre_dispatch_reject'   // gate pre-dispatch bloqueou (kill/cooldown/dedup/etc)
  | 'kill_switch'           // PnL kill switch acionou
  | 'cooldown'              // failure cooldown ativou
  | 'gas_reserve'           // gas reserve warn/critical
  | 'whale_swap'            // mempool whale detectado (item 2 futuro)
  | 'reorg'                 // reorg detectado (item 9 futuro)
  | 'discovery_tick'        // tick de discovery completou
  | 'boot'                  // bot bootou
  | 'shutdown'              // bot shutdown
  | 'opportunity_found'     // backrun opportunity identificada
  | 'opportunity_rejected'  // backrun rejected
  | 'arb_observed'          // DRY_RUN: spread cross-DEX observado pelo detector (não executado)
  | 'mis_observed'          // DRY_RUN: ineficiência viável observada pelo MIS scanner
  | 'arb_triangular_observed' // DRY_RUN: ciclo triangular (A→B→C→A) lucrativo observado
  // ─── Inteligência "órfã" trazida pro ledger central (snapshot via buildObservationEvent) ───
  | 'competitor'            // snapshot de perfil/agregado de competidores (senderRegistry)
  | 'market_bribe'          // quanto o mercado paga de bribe/priority fee (agregado de competidores)
  | 'pnl_reconciled'        // reconciliação PnL: esperado vs realizado + drift + atribuição
  | 'failure_recorded'      // falha categorizada (failureCollector) — pra análise post-mortem
  | 'cluster'               // cluster sybil/co-ocorrência + builder attribution
  | 'dedup'                 // decisão de dedup (posição quase-duplicada suprimida)
  | 'token_vetted';         // porteiro de tokens: token entrou/saiu do universo (com motivo)

export type EventMode = 'dryrun' | 'testnet' | 'mainnet';
export type EventSeverity = 'info' | 'warn' | 'critical';

/**
 * Evento canônico persistido no time-series store.
 *
 * Campos opcionais permitem normalizar eventos de naturezas diferentes
 * num único schema (queries cross-event ficam triviais).
 */
export interface HistoricalEvent {
  // ─── Identificação ───
  id: string;                       // ULID-like, único, gerado no ingester
  timestamp: number;                // Unix ms
  source_event_type: string;        // type original do ZeusEvent (ex: 'tx.confirmed')

  // ─── Dimensões temporais pré-computadas (pra agg rápido) ───
  hour_utc: number;                 // 0-23
  weekday: number;                  // 0-6 (0 = domingo)
  iso_week: number;                 // 1-53

  // ─── Contexto ───
  chain: string;                    // 'Base', 'Arbitrum', etc
  category: EventCategory;
  mode: EventMode;
  severity: EventSeverity;

  // ─── Identificadores opcionais ───
  protocol?: string | undefined;    // 'aave-v3', 'compound-v3', 'morpho-blue', 'backrun'
  pair?: string | undefined;        // 'USDC/WETH'
  borrower?: string | undefined;    // address
  sender?: string | undefined;      // address (whale, competitor)
  tx_hash?: string | undefined;
  block_number?: bigint | undefined;

  // ─── Métricas opcionais ───
  amount_usd?: number | undefined;        // tamanho da operação
  profit_usd?: number | undefined;        // profit líquido (se aplicável)
  gas_usd?: number | undefined;
  slippage_bps?: number | undefined;
  profit_delta_bps?: number | undefined;  // real vs esperado

  // ─── Raw payload pra dados que não cabem em campos típicos ───
  payload: Record<string, unknown>; // serializado como JSON no DuckDB
}

/**
 * SQL schema (executado no init do DuckDB).
 * Indexes otimizados pras queries mais comuns:
 *  - timestamp range (rolling windows)
 *  - chain + category (filtros principais)
 *  - hour_utc + protocol (agregados hourly)
 */
export const EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id VARCHAR PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  source_event_type VARCHAR NOT NULL,
  hour_utc INTEGER NOT NULL,
  weekday INTEGER NOT NULL,
  iso_week INTEGER NOT NULL,
  chain VARCHAR NOT NULL,
  category VARCHAR NOT NULL,
  mode VARCHAR NOT NULL,
  severity VARCHAR NOT NULL,
  protocol VARCHAR,
  pair VARCHAR,
  borrower VARCHAR,
  sender VARCHAR,
  tx_hash VARCHAR,
  block_number BIGINT,
  amount_usd DOUBLE,
  profit_usd DOUBLE,
  gas_usd DOUBLE,
  slippage_bps INTEGER,
  profit_delta_bps INTEGER,
  payload VARCHAR  -- JSON serializado
);

CREATE INDEX IF NOT EXISTS idx_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_chain_category ON events(chain, category);
CREATE INDEX IF NOT EXISTS idx_hour_protocol ON events(hour_utc, protocol);
CREATE INDEX IF NOT EXISTS idx_category_timestamp ON events(category, timestamp);
CREATE INDEX IF NOT EXISTS idx_borrower ON events(borrower);
CREATE INDEX IF NOT EXISTS idx_sender ON events(sender);
`;

/**
 * Computa dimensões temporais pré-calculadas a partir do Unix ms.
 * Usado pelo eventIngester antes de persistir.
 */
export function computeTimeDimensions(timestamp: number): {
  hour_utc: number;
  weekday: number;
  iso_week: number;
} {
  const d = new Date(timestamp);
  const hour_utc = d.getUTCHours();
  const weekday = d.getUTCDay(); // 0 = domingo

  // ISO week (1-53). Spec: week starts Monday, week 1 contém o primeiro Thursday do ano.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThursdayDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNr + 3);
  const iso_week = Math.ceil(((target.getTime() - firstThursday.getTime()) / 86400000 + 1) / 7);

  return { hour_utc, weekday, iso_week };
}

/**
 * Gera ULID-like ID (lexicographically sortable + timestamp embedded).
 * Não usa libs externas pra evitar deps. Não é ULID puro mas atende propósito.
 */
export function generateEventId(timestamp: number): string {
  const tsHex = timestamp.toString(16).padStart(12, '0');
  const random = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  const random2 = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `${tsHex}-${random}-${random2}`;
}
