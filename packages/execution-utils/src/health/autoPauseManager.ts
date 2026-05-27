/**
 * AutoPauseManager — Item 12 H10 do checklist.
 *
 * Centraliza decisão de pausar dispatches em anomalia crítica.
 * Substitui kill switch unilateral (que só olha PnL) por policy modular que
 * agrega múltiplos sinais.
 *
 * Reasons que ativam pause:
 *  - PnL kill switch (loss diário > limit)
 *  - Failure cooldown ativo
 *  - Gas reserve critical
 *  - Block staleness critical (sequencer travado)
 *  - Reorg circuit breaker (>N reorgs em window)
 *  - Process memory critical
 *  - Event loop lag critical
 *
 * Caller (pipeline pré-dispatch) consulta `shouldPause()` antes de submeter.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export interface PauseReason {
  source: string;
  severity: 'warn' | 'critical';
  message: string;
  set_at: number;
}

export interface AutoPauseStatus {
  paused: boolean;
  reasons: PauseReason[];
  /** True se pelo menos 1 reason CRITICAL. */
  hard_pause: boolean;
}

export interface AutoPauseManagerOpts {
  logger?: LoggerLike;
}

/**
 * Gerencia razões ativas de pause. Múltiplos componentes podem
 * setar/limpar reasons independentemente.
 *
 * Uso:
 *   const pauser = new AutoPauseManager({ logger });
 *
 *   // Subscribers nos health checks:
 *   stalenessCheck.onStatusChange(r => {
 *     if (r.status === 'critical') {
 *       pauser.setReason('block_staleness', 'critical', `${r.age_seconds}s sem novo bloco`);
 *     } else {
 *       pauser.clearReason('block_staleness');
 *     }
 *   });
 *
 *   // Pipeline pré-dispatch:
 *   if (pauser.shouldPause()) return { skip: true, reason: pauser.summary() };
 */
export class AutoPauseManager {
  private readonly logger: LoggerLike | undefined;
  private readonly reasons = new Map<string, PauseReason>();

  constructor(opts: AutoPauseManagerOpts = {}) {
    this.logger = opts.logger;
  }

  /**
   * Marca razão ativa de pause.
   * Se source já existe, atualiza.
   */
  setReason(source: string, severity: 'warn' | 'critical', message: string): void {
    const existing = this.reasons.get(source);
    const wasInactive = !existing;

    this.reasons.set(source, {
      source,
      severity,
      message,
      set_at: existing?.set_at ?? Date.now(),
    });

    if (wasInactive || existing?.severity !== severity) {
      this.logger?.warn(
        { source, severity, message, totalReasons: this.reasons.size },
        `⏸️  AutoPause: ${source} = ${severity} — ${message}`,
      );
    }
  }

  /**
   * Remove razão (componente recovered).
   */
  clearReason(source: string): void {
    if (this.reasons.delete(source)) {
      this.logger?.info(
        { source, remainingReasons: this.reasons.size },
        `▶️  AutoPause: ${source} cleared (remaining ${this.reasons.size})`,
      );
    }
  }

  /**
   * True se ANY reason crítica ativa (hard pause).
   * Reasons 'warn' NÃO pausam — só log + monitoring.
   */
  shouldPause(): boolean {
    for (const r of this.reasons.values()) {
      if (r.severity === 'critical') return true;
    }
    return false;
  }

  /**
   * Status completo pra readiness probe / debug.
   */
  status(): AutoPauseStatus {
    const reasons = [...this.reasons.values()];
    return {
      paused: this.shouldPause(),
      reasons,
      hard_pause: reasons.some((r) => r.severity === 'critical'),
    };
  }

  /**
   * Resumo legível pra log/Discord.
   */
  summary(): string {
    if (this.reasons.size === 0) return 'no active pause reasons';
    return [...this.reasons.values()]
      .map((r) => `${r.source}=${r.severity}(${r.message})`)
      .join('; ');
  }
}
