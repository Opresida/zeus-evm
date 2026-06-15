/**
 * Time-Series Store — DuckDB embedded pra Historical Intelligence (Item 15).
 *
 * Por que DuckDB:
 *  - Columnar (queries analíticas pesadas são rápidas)
 *  - Embedded (sem servidor, sem container)
 *  - File único (`.duckdb`), fácil backup/copy
 *  - Suporta queries SQL completas (GROUP BY, window functions, JOINs)
 *  - Reads paralelos
 *  - Zero custo operacional
 *
 * Persistência:
 *  - Arquivo local (`logs/intelligence.duckdb` default)
 *  - Append-only via writes batched
 *  - Schema definido em intelligenceSchema.ts (eventos canônicos)
 *
 * Performance:
 *  - Batch writes (acumula até N events ou flushIntervalMs, então flush)
 *  - Prepared statements pra reuso
 *  - Connection persistente (não reabre por write)
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

import {
  EVENTS_TABLE_DDL,
  type HistoricalEvent,
} from './intelligenceSchema';

export interface TimeseriesStoreOpts {
  /** Path do arquivo .duckdb. Default: 'logs/intelligence.duckdb'. */
  dbPath?: string;
  /** Tamanho do batch antes de flush automático. Default 100. */
  batchSize?: number;
  /** Intervalo máximo em ms entre flushes. Default 5000 (5s). */
  flushIntervalMs?: number;
  logger?: LoggerLike;
}

export interface TimeseriesStats {
  totalEvents: number;
  pendingWrites: number;
  lastFlushAt: number | null;
  totalFlushes: number;
  flushErrors: number;
}

const DEFAULT_DB_PATH = 'logs/intelligence.duckdb';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/**
 * Wrapper sobre DuckDB com batched writes + query API.
 *
 * Uso típico:
 *   const store = new TimeseriesStore({ logger });
 *   await store.init();
 *   store.ingest(eventA);
 *   store.ingest(eventB);
 *   // ... batch flush automaticamente
 *   const events = await store.query(`SELECT * FROM events WHERE chain='Base' LIMIT 10`);
 *   await store.shutdown();
 */
export class TimeseriesStore {
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private readonly dbPath: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly logger: LoggerLike | undefined;

  private pendingWrites: HistoricalEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private totalEvents = 0;
  private totalFlushes = 0;
  private flushErrors = 0;
  private lastFlushAt: number | null = null;
  private shuttingDown = false;

  constructor(opts: TimeseriesStoreOpts = {}) {
    this.dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.logger = opts.logger;
  }

  /**
   * Inicializa DuckDB + cria schema se não existir.
   * Idempotente — chamar várias vezes não causa problema.
   */
  async init(): Promise<void> {
    if (this.instance) return;

    // Garante diretório do db
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    this.instance = await DuckDBInstance.create(this.dbPath);
    this.connection = await this.instance.connect();

    // Cria schema (CREATE TABLE IF NOT EXISTS)
    await this.connection.run(EVENTS_TABLE_DDL);

    this.logger?.info(
      { dbPath: this.dbPath, batchSize: this.batchSize, flushIntervalMs: this.flushIntervalMs },
      '🗄️  TimeseriesStore (DuckDB) pronto',
    );

    // Starta timer de flush periódico
    this._startFlushTimer();
  }

  /**
   * Adiciona evento ao buffer. Se buffer atinge batchSize, flush imediato.
   * Não bloqueia caller (não é async).
   */
  ingest(event: HistoricalEvent): void {
    if (this.shuttingDown) return;
    this.pendingWrites.push(event);

    if (this.pendingWrites.length >= this.batchSize) {
      // Flush async, sem bloquear caller
      void this._flushNow().catch((err) => {
        this.logger?.error(
          { err: err instanceof Error ? err.message : err },
          'TimeseriesStore flush falhou (batch full)',
        );
      });
    }
  }

  /**
   * Força flush imediato dos pending writes.
   */
  async flush(): Promise<void> {
    await this._flushNow();
  }

  /**
   * Query SQL sobre eventos. Retorna rows como Record<string, unknown>.
   */
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    if (!this.connection) throw new Error('TimeseriesStore not initialized');
    const reader = await this.connection.runAndReadAll(sql);
    return reader.getRowObjects() as T[];
  }

  /**
   * Stats pra observabilidade.
   */
  stats(): TimeseriesStats {
    return {
      totalEvents: this.totalEvents,
      pendingWrites: this.pendingWrites.length,
      lastFlushAt: this.lastFlushAt,
      totalFlushes: this.totalFlushes,
      flushErrors: this.flushErrors,
    };
  }

  /**
   * Conta eventos por categoria (uso comum em dashboards).
   */
  async countByCategory(): Promise<Record<string, number>> {
    const rows = await this.query<{ category: string; count: bigint }>(
      'SELECT category, COUNT(*) as count FROM events GROUP BY category',
    );
    return Object.fromEntries(rows.map((r) => [r.category, Number(r.count)]));
  }

  /**
   * Drena buffer + fecha connection + fecha a instância. Chamar antes de exit do processo.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this._flushNow();
    if (this.connection) {
      this.connection.disconnectSync();
      this.connection = null;
    }
    // Fecha a instância explicitamente — sem isso o handle do arquivo DuckDB fica preso
    // até o GC. No Windows o OS mantém lock exclusivo nesse meio-tempo, quebrando reopen/ATTACH
    // do mesmo arquivo (ex.: attachAndRankPairs). Linux é mais tolerante, mas fechar é o correto.
    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
    }
    this.logger?.info({ totalEvents: this.totalEvents }, '🗄️  TimeseriesStore shutdown');
  }

  // ─── Internal ───

  private _startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.pendingWrites.length > 0) {
        void this._flushNow().catch((err) => {
          this.logger?.error(
            { err: err instanceof Error ? err.message : err },
            'TimeseriesStore flush falhou (timer)',
          );
        });
      }
    }, this.flushIntervalMs);
    // Não impede process de exitar
    this.flushTimer.unref();
  }

  private async _flushNow(): Promise<void> {
    if (this.pendingWrites.length === 0) return;
    if (!this.connection) throw new Error('TimeseriesStore not initialized');

    const batch = this.pendingWrites;
    this.pendingWrites = [];

    try {
      // Constrói INSERT em batch único
      // DuckDB suporta `INSERT INTO t VALUES (...), (...), (...)` eficientemente
      const placeholders: string[] = [];
      const values: unknown[] = [];

      for (const ev of batch) {
        placeholders.push(
          '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        );
        values.push(
          ev.id,
          ev.timestamp,
          ev.source_event_type,
          ev.hour_utc,
          ev.weekday,
          ev.iso_week,
          ev.chain,
          ev.category,
          ev.mode,
          ev.severity,
          ev.protocol ?? null,
          ev.pair ?? null,
          ev.borrower ?? null,
          ev.sender ?? null,
          ev.tx_hash ?? null,
          ev.block_number !== undefined ? ev.block_number.toString() : null,
          ev.amount_usd ?? null,
          ev.profit_usd ?? null,
          ev.gas_usd ?? null,
          ev.slippage_bps ?? null,
          ev.profit_delta_bps ?? null,
          JSON.stringify(ev.payload),
        );
      }

      const sql = `INSERT INTO events VALUES ${placeholders.join(',')}`;
      const prepared = await this.connection.prepare(sql);

      // Bind valores
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null) {
          prepared.bindNull(i + 1);
        } else if (typeof v === 'number') {
          // Distingue int vs double pra binding correto
          if (Number.isInteger(v)) {
            // INTEGER do DuckDB é INT32 — `timestamp` (Unix ms, ~1.7e12) estoura.
            // Inteiros fora do range de 32 bits vão como BIGINT (coluna timestamp é BIGINT,
            // usada pras rolling windows de scoring/analytics).
            if (v > 2_147_483_647 || v < -2_147_483_648) {
              prepared.bindBigInt(i + 1, BigInt(v));
            } else {
              prepared.bindInteger(i + 1, v);
            }
          } else {
            prepared.bindDouble(i + 1, v);
          }
        } else if (typeof v === 'bigint') {
          // block_number e timestamp ficam como BIGINT
          prepared.bindBigInt(i + 1, v);
        } else if (typeof v === 'string') {
          prepared.bindVarchar(i + 1, v);
        } else {
          prepared.bindVarchar(i + 1, String(v));
        }
      }

      await prepared.run();
      prepared.destroySync();

      this.totalEvents += batch.length;
      this.totalFlushes++;
      this.lastFlushAt = Date.now();

      this.logger?.debug(
        { batchSize: batch.length, totalEvents: this.totalEvents },
        `💾 TimeseriesStore: ${batch.length} eventos flushed`,
      );
    } catch (err) {
      this.flushErrors++;
      this.logger?.error(
        {
          err: err instanceof Error ? err.message : err,
          batchSize: batch.length,
          flushErrors: this.flushErrors,
        },
        'TimeseriesStore flush erro — re-enfileirando batch',
      );
      // Re-enfileira batch pra retry no próximo flush
      this.pendingWrites.unshift(...batch);
    }
  }
}
