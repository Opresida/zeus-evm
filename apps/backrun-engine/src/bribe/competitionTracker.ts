/**
 * CompetitionTracker — observa indicadores de competição em tempo real.
 *
 * MVP: tracker simples de pending tx que o decoder identificou como swaps em routers
 * conhecidos. O número alto indica que outros bots/users estão fazendo swaps no mesmo
 * ciclo de bloco — sinal pro gasWarDetector.
 *
 * Futuro: integrar com Flashbots bundle stats API + Atlas competition API quando ativarmos
 * mempool premium e bundle relays.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export interface CompetitionStats {
  /** Pending tx detectadas como swaps em routers conhecidos (último bloco). */
  pendingTxToKnownRouters: number;
  /** Reset timestamp do contador (ms). */
  resetAt: number;
}

export interface CompetitionTrackerOpts {
  /** Janela do contador em ms (default 12s = ~1 bloco Base). */
  windowMs?: number;
  logger?: LoggerLike;
}

const DEFAULT_WINDOW_MS = 12_000;

export class CompetitionTracker {
  private pendingTxCount = 0;
  private windowStart = Date.now();
  private readonly windowMs: number;
  private readonly logger: LoggerLike | undefined;

  constructor(opts: CompetitionTrackerOpts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.logger = opts.logger;
  }

  /**
   * Chamado pelo whaleSwapSubscription quando decode bem-sucedido (router conhecido).
   */
  recordPendingTxToKnownRouter(): void {
    this._maybeReset();
    this.pendingTxCount++;
  }

  /**
   * Snapshot do estado atual.
   */
  stats(): CompetitionStats {
    this._maybeReset();
    return {
      pendingTxToKnownRouters: this.pendingTxCount,
      resetAt: this.windowStart,
    };
  }

  private _maybeReset(): void {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.pendingTxCount = 0;
      this.windowStart = now;
    }
  }
}
