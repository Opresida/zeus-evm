/**
 * ProcessCheck — Item 12 H7 do checklist.
 *
 * Monitora saúde do process Node:
 *  - Memory usage (RSS + heap)
 *  - Event loop lag (sintoma de blocking ou overload)
 *  - Uptime
 *
 * Útil pra detectar memory leak (RSS subindo continuamente) ou bot travado
 * em loop CPU-bound (event loop lag alto).
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export type ProcessStatus = 'ok' | 'warn' | 'critical';

export interface ProcessHealth {
  status: ProcessStatus;
  uptime_sec: number;
  memory_mb: {
    rss: number;        // Resident Set Size (memória física)
    heap_used: number;
    heap_total: number;
  };
  event_loop_lag_ms: number;
  pid: number;
  checked_at: number;
}

export interface ProcessCheckOpts {
  /** Threshold memory RSS warn em MB. Default 1000 (~1GB). */
  memoryWarnMb?: number;
  /** Threshold memory RSS critical em MB. Default 1500 (~1.5GB). */
  memoryCriticalMb?: number;
  /** Threshold event loop lag warn em ms. Default 200ms. */
  loopLagWarnMs?: number;
  /** Threshold event loop lag critical em ms. Default 1000ms. */
  loopLagCriticalMs?: number;
  /** Intervalo de check em ms. Default 5000. */
  pollIntervalMs?: number;
  logger?: LoggerLike;
}

const DEFAULTS = {
  memoryWarnMb: 1000,
  memoryCriticalMb: 1500,
  loopLagWarnMs: 200,
  loopLagCriticalMs: 1000,
  pollIntervalMs: 5_000,
};

/**
 * Mede event loop lag usando setImmediate vs Date.now diff.
 */
function measureEventLoopLag(): Promise<number> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const elapsedNs = process.hrtime.bigint() - start;
      resolve(Number(elapsedNs) / 1e6); // ns → ms
    });
  });
}

export class ProcessCheck {
  private readonly memWarnMb: number;
  private readonly memCriticalMb: number;
  private readonly lagWarnMs: number;
  private readonly lagCriticalMs: number;
  private readonly pollMs: number;
  private readonly logger: LoggerLike | undefined;
  private readonly startedAt = Date.now();

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastHealth: ProcessHealth;
  private listeners: ((h: ProcessHealth) => void)[] = [];

  constructor(opts: ProcessCheckOpts = {}) {
    this.memWarnMb = opts.memoryWarnMb ?? DEFAULTS.memoryWarnMb;
    this.memCriticalMb = opts.memoryCriticalMb ?? DEFAULTS.memoryCriticalMb;
    this.lagWarnMs = opts.loopLagWarnMs ?? DEFAULTS.loopLagWarnMs;
    this.lagCriticalMs = opts.loopLagCriticalMs ?? DEFAULTS.loopLagCriticalMs;
    this.pollMs = opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.logger = opts.logger;

    this.lastHealth = this._snapshot(0);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this._checkOnce();
    this.timer = setInterval(() => void this._checkOnce(), this.pollMs);
    this.timer.unref();
    this.logger?.info(
      { memWarnMb: this.memWarnMb, memCriticalMb: this.memCriticalMb, lagWarnMs: this.lagWarnMs },
      '🩺 ProcessCheck iniciado',
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onStatusChange(listener: (h: ProcessHealth) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getStatus(): ProcessHealth {
    return { ...this.lastHealth };
  }

  // ─── Internal ───

  private async _checkOnce(): Promise<void> {
    if (!this.running) return;
    try {
      const lag = await measureEventLoopLag();
      const health = this._snapshot(lag);
      const prev = this.lastHealth.status;
      this.lastHealth = health;

      if (health.status !== prev) {
        this.logger?.warn(
          {
            from: prev,
            to: health.status,
            memoryRssMb: health.memory_mb.rss.toFixed(1),
            eventLoopLagMs: health.event_loop_lag_ms.toFixed(1),
          },
          `🩺 ProcessCheck: ${prev} → ${health.status}`,
        );
        this._notifyListeners();
      }
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'ProcessCheck: erro ao medir',
      );
    }
  }

  private _snapshot(lagMs: number): ProcessHealth {
    const mem = process.memoryUsage();
    const rss_mb = mem.rss / 1024 / 1024;
    const heap_used = mem.heapUsed / 1024 / 1024;
    const heap_total = mem.heapTotal / 1024 / 1024;

    let status: ProcessStatus = 'ok';
    if (rss_mb >= this.memCriticalMb || lagMs >= this.lagCriticalMs) status = 'critical';
    else if (rss_mb >= this.memWarnMb || lagMs >= this.lagWarnMs) status = 'warn';

    return {
      status,
      uptime_sec: Math.floor((Date.now() - this.startedAt) / 1000),
      memory_mb: {
        rss: rss_mb,
        heap_used,
        heap_total,
      },
      event_loop_lag_ms: lagMs,
      pid: process.pid,
      checked_at: Date.now(),
    };
  }

  private _notifyListeners(): void {
    for (const l of this.listeners) {
      try {
        l(this.lastHealth);
      } catch {
        // skip
      }
    }
  }
}
