/**
 * BlockStalenessCheck — Item 12 H3 do checklist.
 *
 * Detecta quando a chain (RPC ou sequencer) parou de produzir blocos.
 * Cenário crítico Base: sequencer Coinbase trava ocasionalmente → bot submetendo
 * pendings que não confirmam → fila acumula → operador descobre tarde.
 *
 * Heurística simples: a cada N segundos, compara `block.timestamp` do latest
 * com `now`. Se diff > threshold, marca CRITICAL.
 */

import type { PublicClient } from 'viem';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

type AnyPublicClient = PublicClient<any, any>;

export type StalenessStatus = 'ok' | 'warn' | 'critical';

export interface StalenessResult {
  status: StalenessStatus;
  latest_block_number: bigint | null;
  latest_block_timestamp: number | null;
  age_seconds: number;
  threshold_warn_sec: number;
  threshold_critical_sec: number;
  checked_at: number;
  error?: string;
}

export interface BlockStalenessCheckOpts {
  client: AnyPublicClient;
  /** Threshold pra warn em segundos. Default 15s (Base block ~2s, 7-block tolerance). */
  thresholdWarnSec?: number;
  /** Threshold pra critical em segundos. Default 60s (sequencer claramente travado). */
  thresholdCriticalSec?: number;
  /** Intervalo de check em ms. Default 10000 (10s). */
  pollIntervalMs?: number;
  logger?: LoggerLike;
}

const DEFAULT_WARN_SEC = 15;
const DEFAULT_CRITICAL_SEC = 60;
const DEFAULT_POLL_MS = 10_000;

export class BlockStalenessCheck {
  private readonly client: AnyPublicClient;
  private readonly warnSec: number;
  private readonly criticalSec: number;
  private readonly pollMs: number;
  private readonly logger: LoggerLike | undefined;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastResult: StalenessResult;
  private listeners: ((r: StalenessResult) => void)[] = [];

  constructor(opts: BlockStalenessCheckOpts) {
    this.client = opts.client;
    this.warnSec = opts.thresholdWarnSec ?? DEFAULT_WARN_SEC;
    this.criticalSec = opts.thresholdCriticalSec ?? DEFAULT_CRITICAL_SEC;
    this.pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.logger = opts.logger;

    this.lastResult = {
      status: 'ok',
      latest_block_number: null,
      latest_block_timestamp: null,
      age_seconds: 0,
      threshold_warn_sec: this.warnSec,
      threshold_critical_sec: this.criticalSec,
      checked_at: Date.now(),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this._checkOnce();
    this.timer = setInterval(() => void this._checkOnce(), this.pollMs);
    this.timer.unref();
    this.logger?.info(
      { warnSec: this.warnSec, criticalSec: this.criticalSec, pollMs: this.pollMs },
      '⏱️  BlockStalenessCheck iniciado',
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Subscribe pra mudanças de status.
   */
  onStatusChange(listener: (r: StalenessResult) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getStatus(): StalenessResult {
    return { ...this.lastResult };
  }

  // ─── Internal ───

  private async _checkOnce(): Promise<void> {
    if (!this.running) return;
    try {
      const block = await this.client.getBlock({ blockTag: 'latest' });
      const tsMs = Number(block.timestamp) * 1000;
      const now = Date.now();
      const ageSec = (now - tsMs) / 1000;

      let status: StalenessStatus = 'ok';
      if (ageSec >= this.criticalSec) status = 'critical';
      else if (ageSec >= this.warnSec) status = 'warn';

      const prev = this.lastResult.status;
      this.lastResult = {
        status,
        latest_block_number: block.number ?? null,
        latest_block_timestamp: tsMs,
        age_seconds: ageSec,
        threshold_warn_sec: this.warnSec,
        threshold_critical_sec: this.criticalSec,
        checked_at: now,
      };

      if (status !== prev) {
        this.logger?.warn(
          {
            from: prev,
            to: status,
            ageSec: ageSec.toFixed(1),
            latestBlock: block.number?.toString(),
          },
          `⏱️  Block staleness: ${prev} → ${status} (age ${ageSec.toFixed(1)}s)`,
        );
        this._notifyListeners();
      }
    } catch (err) {
      this.lastResult = {
        ...this.lastResult,
        status: 'critical',
        error: err instanceof Error ? err.message : String(err),
        checked_at: Date.now(),
      };
      this.logger?.error(
        { err: err instanceof Error ? err.message : err },
        'BlockStalenessCheck: erro fetching latest block',
      );
      this._notifyListeners();
    }
  }

  private _notifyListeners(): void {
    for (const l of this.listeners) {
      try {
        l(this.lastResult);
      } catch {
        // skip
      }
    }
  }
}
