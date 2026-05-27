/**
 * FailureCollector — coletor central de failures com persistence JSONL dedicada.
 *
 * Estratégia:
 *  - JSONL append-only com rotação diária (`logs/failures/YYYY-MM-DD.jsonl`)
 *  - Buffered async writes (não bloqueia hot path)
 *  - Stats rolling 24h em memória pra Discord daily digest
 *  - Schema rico (FailureEvent) — ML-ready pra IA futura
 *
 * Separação de responsabilidades:
 *  - `pnlTracker`: rolling 24h pra kill switch (focado em $$ perdido)
 *  - `failureTracker`: cooldown após N falhas (focado em count consecutivo)
 *  - **FailureCollector**: persistência rica pra ANÁLISE POST-MORTEM
 *  - `intelligenceStore` (item 15): dataset agregado pra ML training
 *
 * Esses 4 componentes alimentam dimensões diferentes — não overlap real.
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { FailureEvent, FailureAnalyticsStats, FailureCategory } from './failureSchema';

export interface FailureCollectorOpts {
  /** Diretório base de logs. Default 'logs/failures'. */
  baseDir?: string;
  /** Janela rolling em ms pra stats. Default 24h. */
  windowMs?: number;
  logger?: LoggerLike;
}

const DEFAULT_BASE_DIR = 'logs/failures';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const ALL_CATEGORIES: FailureCategory[] = [
  'reverted_on_chain', 'lost_race', 'sim_passed_but_reverted',
  'unprofitable_after_slippage', 'frontrun_by_bot', 'sandwich_loss',
  'gas_outbid', 'simulation_mismatch', 'orphaned_in_reorg',
  'rejected_pre_dispatch', 'unknown',
];

export class FailureCollector {
  private readonly baseDir: string;
  private readonly windowMs: number;
  private readonly logger: LoggerLike | undefined;

  private rollingWindow: FailureEvent[] = [];

  constructor(opts: FailureCollectorOpts = {}) {
    this.baseDir = opts.baseDir ?? DEFAULT_BASE_DIR;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.logger = opts.logger;

    // Garante diretório existe
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Registra failure: persiste no JSONL do dia + acumula no rolling window.
   * Não bloqueia caller — sync append (rápido, ~ms) + window in-memory.
   */
  record(event: FailureEvent): void {
    try {
      // Persiste no JSONL do dia
      const filePath = this._dailyFilePath(event.timestamp);
      // Garante dir do path (caso baseDir tenha subdirs)
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      appendFileSync(
        filePath,
        JSON.stringify(event) + '\n',
        { encoding: 'utf-8' },
      );

      // Mantém window in-memory pra stats
      this.rollingWindow.push(event);
      this._pruneOldEntries();
    } catch (err) {
      // Falhar silenciosamente — collector NUNCA derruba o bot
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err, eventId: event.id },
        'FailureCollector: erro persistindo failure (drop silencioso)',
      );
    }
  }

  /**
   * Stats agregados rolling 24h pra Discord daily digest.
   */
  stats(): FailureAnalyticsStats {
    this._pruneOldEntries();

    const byCategory: Record<FailureCategory, number> = {} as Record<FailureCategory, number>;
    for (const cat of ALL_CATEGORIES) byCategory[cat] = 0;

    let totalUsdLost = 0;
    for (const ev of this.rollingWindow) {
      byCategory[ev.category] = (byCategory[ev.category] ?? 0) + 1;
      totalUsdLost += ev.our_gas_usd_lost ?? 0;
    }

    return {
      total: this.rollingWindow.length,
      byCategory,
      totalUsdLost,
      windowMs: this.windowMs,
    };
  }

  /**
   * Conta failures por categoria (snapshot atual).
   */
  countByCategory(): Record<string, number> {
    return this.stats().byCategory;
  }

  /**
   * Lista failures recentes (default últimos 20). Útil pra debug.
   */
  recent(limit = 20): FailureEvent[] {
    return this.rollingWindow.slice(-limit);
  }

  // ─── Internal ───

  private _dailyFilePath(timestamp: number): string {
    const d = new Date(timestamp);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return join(this.baseDir, `${yyyy}-${mm}-${dd}.jsonl`);
  }

  private _pruneOldEntries(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.rollingWindow.length > 0 && (this.rollingWindow[0]?.timestamp ?? 0) < cutoff) {
      this.rollingWindow.shift();
    }
  }
}
