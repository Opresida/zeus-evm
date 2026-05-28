/**
 * BorrowerCache — cache acumulativo de borrowers pro discovery on-chain.
 *
 * Resolve a lacuna do event scan: getLogs só vê quem emitiu Borrow na janela
 * recente (~5.5h Base). Um borrower silencioso que ficou liquidável por queda
 * de preço (sem emitir evento) seria perdido.
 *
 * Estratégia:
 *  - Boot: scan profundo 1x monta a base
 *  - Cada tick: adiciona novos borrowers da janela ao set persistente
 *  - HF check roda em TODOS os acumulados (não só janela)
 *  - Auto-poda: borrower que zerou dívida (totalDebtBase == 0) sai do set
 *
 * Persistência: JSONL snapshot por (chain, market). Sobrevive a restart.
 *
 * 100% off-chain — sem impacto de bytecode/contrato.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Address } from 'viem';
import { NOOP_LOGGER, type LoggerLike } from './logger';

export interface BorrowerCacheOpts {
  /** Diretório de persistência. Default 'logs/borrowers'. */
  baseDir?: string;
  /** Chain shortName (ex 'base') — compõe o nome do arquivo. */
  chain: string;
  /** Market label (ex 'seamless', 'aave-v3') — compõe o nome do arquivo. */
  market: string;
  logger?: LoggerLike;
}

const DEFAULT_BASE_DIR = 'logs/borrowers';

/**
 * Set persistente de borrowers conhecidos por (chain, market).
 */
export class BorrowerCache {
  private readonly snapshotPath: string;
  private readonly logger: LoggerLike;
  private readonly borrowers = new Set<string>();

  constructor(opts: BorrowerCacheOpts) {
    const baseDir = opts.baseDir ?? DEFAULT_BASE_DIR;
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
    this.snapshotPath = join(baseDir, `${opts.chain}-${opts.market}.json`);
    this.logger = opts.logger ?? NOOP_LOGGER;
    this._load();
  }

  /**
   * Adiciona borrowers (lowercase). Retorna quantos eram NOVOS.
   */
  add(addrs: readonly Address[]): number {
    let added = 0;
    for (const a of addrs) {
      const key = a.toLowerCase();
      if (!this.borrowers.has(key)) {
        this.borrowers.add(key);
        added++;
      }
    }
    return added;
  }

  /**
   * Remove borrowers que não interessam mais (ex: zeraram dívida).
   */
  remove(addrs: readonly Address[]): number {
    let removed = 0;
    for (const a of addrs) {
      if (this.borrowers.delete(a.toLowerCase())) removed++;
    }
    return removed;
  }

  /** Todos os borrowers conhecidos. */
  all(): Address[] {
    return Array.from(this.borrowers) as Address[];
  }

  size(): number {
    return this.borrowers.size;
  }

  /**
   * Persiste snapshot. Chamar após cada tick (ou em shutdown).
   */
  save(): void {
    try {
      writeFileSync(
        this.snapshotPath,
        JSON.stringify({ version: 1, borrowers: Array.from(this.borrowers) }),
        'utf-8',
      );
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : err, path: this.snapshotPath },
        'BorrowerCache: erro salvando snapshot (drop silencioso)',
      );
    }
  }

  // ─── Internal ───

  private _load(): void {
    if (!existsSync(this.snapshotPath)) return;
    try {
      const raw = readFileSync(this.snapshotPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: number; borrowers?: string[] };
      if (parsed.version === 1 && Array.isArray(parsed.borrowers)) {
        for (const b of parsed.borrowers) this.borrowers.add(b.toLowerCase());
        this.logger.info(
          { count: this.borrowers.size, path: this.snapshotPath },
          `📂 BorrowerCache carregado (${this.borrowers.size} borrowers)`,
        );
      }
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : err },
        'BorrowerCache: erro carregando snapshot — começando vazio',
      );
    }
  }
}
