/**
 * Failure Tracker — contador de falhas consecutivas + cooldown timer.
 *
 * Diferente do PnL tracker (que mede USD acumulado em 24h), este conta
 * FALHAS CONSECUTIVAS recentes. Quando N falhas em sequência (default 3),
 * pausa o bot por X minutos (default 5) pra calibração.
 *
 * Sem isso, bot pode entrar em loop infinito: 100 tx revertendo seguidas
 * = $20+ em gas perdido, queima de gas wallet, alerta caro.
 *
 * O que conta como falha consecutiva:
 *   - Tx revertida on-chain (após submit): conta
 *   - Tx confirmada com net negativo: conta (perdeu dinheiro)
 *   - Tx revertida pre-dispatch (gate simulação): NÃO conta (proteção funcionando)
 *   - Sucesso (win): RESETA contador
 *
 * Estado transitório — não persiste em disco. Restart reseta (esperado).
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export interface FailureStats {
  consecutiveFailures: number;
  maxAllowed: number;
  inCooldown: boolean;
  cooldownRemainingMs: number;
  cooldownUntil: number | null;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureReason?: string;
}

export interface FailureTrackerOpts {
  maxConsecutiveFailures: number;
  cooldownDurationMs: number;
  logger?: LoggerLike;
}

export class FailureTracker {
  private consecutiveFailures = 0;
  private cooldownUntil: number | null = null;
  private maxAllowed: number;
  private cooldownMs: number;
  private logger: LoggerLike | undefined;

  // Métricas de observabilidade
  private _totalFailures = 0;
  private _totalSuccesses = 0;
  private _lastFailureReason: string | undefined;

  constructor(opts: FailureTrackerOpts) {
    this.maxAllowed = opts.maxConsecutiveFailures;
    this.cooldownMs = opts.cooldownDurationMs;
    this.logger = opts.logger;
  }

  recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      this.logger?.info(
        { previousFailures: this.consecutiveFailures },
        `✅ Success após ${this.consecutiveFailures} falhas — contador resetado`,
      );
    }
    this.consecutiveFailures = 0;
    this._totalSuccesses++;
  }

  recordFailure(reason: string): void {
    this.consecutiveFailures++;
    this._totalFailures++;
    this._lastFailureReason = reason;

    this.logger?.warn(
      {
        consecutive: this.consecutiveFailures,
        maxAllowed: this.maxAllowed,
        reason,
      },
      `⚠️ Falha consecutiva ${this.consecutiveFailures}/${this.maxAllowed} — ${reason.slice(0, 100)}`,
    );

    if (this.consecutiveFailures >= this.maxAllowed) {
      this.cooldownUntil = Date.now() + this.cooldownMs;
      this.logger?.error(
        {
          consecutive: this.consecutiveFailures,
          cooldownMs: this.cooldownMs,
          cooldownUntil: new Date(this.cooldownUntil).toISOString(),
        },
        `🛑 COOLDOWN ATIVADO — ${this.consecutiveFailures} falhas consecutivas. Pausa de ${this.cooldownMs / 1000}s ativada.`,
      );
    }
  }

  /** True se ainda está em janela de cooldown. */
  inCooldown(): boolean {
    if (this.cooldownUntil === null) return false;
    if (Date.now() >= this.cooldownUntil) {
      // Cooldown expirou — limpa estado pra próximas tentativas
      this.cooldownUntil = null;
      this.consecutiveFailures = 0;
      this.logger?.info(
        { previousFailures: this.maxAllowed },
        `🟢 COOLDOWN EXPIROU — bot retomando operação`,
      );
      return false;
    }
    return true;
  }

  remainingCooldownMs(): number {
    if (this.cooldownUntil === null) return 0;
    const remaining = this.cooldownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  stats(): FailureStats {
    // inCooldown() tem side-effect de limpar se expirou — chamar primeiro
    const inCd = this.inCooldown();
    return {
      consecutiveFailures: this.consecutiveFailures,
      maxAllowed: this.maxAllowed,
      inCooldown: inCd,
      cooldownRemainingMs: this.remainingCooldownMs(),
      cooldownUntil: this.cooldownUntil,
      totalFailures: this._totalFailures,
      totalSuccesses: this._totalSuccesses,
      lastFailureReason: this._lastFailureReason,
    };
  }

  /** Reset manual — apenas pra ops/testes. */
  manualReset(reason: string): void {
    this.logger?.warn({ reason }, `⚠️ FailureTracker MANUAL RESET — ${reason}`);
    this.consecutiveFailures = 0;
    this.cooldownUntil = null;
  }
}
