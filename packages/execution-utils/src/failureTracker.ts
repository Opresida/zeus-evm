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
  /** #4 automação — cooldown adaptativo (segundos) que SERIA aplicado agora (backoff por cooldowns repetidos). */
  adaptiveCooldownSec: number;
  /** Base configurada (segundos) — pra o painel mostrar "base → adaptativo". */
  baseCooldownSec: number;
  /** true = o adaptativo está de fato sendo injetado (senão só observa "o que faria"). */
  adaptiveApplied: boolean;
}

export interface FailureTrackerOpts {
  maxConsecutiveFailures: number;
  cooldownDurationMs: number;
  logger?: LoggerLike;
  /** #4 automação — injeta o cooldown adaptativo (backoff). Default false → observa "o que faria". */
  adaptiveCooldownEnabled?: boolean;
  /** Teto do cooldown adaptativo (ms). Default 30min — trava contra backoff descontrolado. */
  maxCooldownMs?: number;
}

export class FailureTracker {
  private consecutiveFailures = 0;
  private cooldownUntil: number | null = null;
  private maxAllowed: number;
  private cooldownMs: number; // base configurada
  private logger: LoggerLike | undefined;

  // #4 automação — cooldown adaptativo (backoff por cooldowns repetidos).
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private adaptiveEnabled: boolean; // chave-mestra pode religar ao vivo (setAdaptiveCooldown)
  private _recentCooldowns = 0; // conta cooldowns na sequência ruim; decai a cada sucesso (histerese)

  // Métricas de observabilidade
  private _totalFailures = 0;
  private _totalSuccesses = 0;
  private _lastFailureReason: string | undefined;

  constructor(opts: FailureTrackerOpts) {
    this.maxAllowed = opts.maxConsecutiveFailures;
    this.cooldownMs = opts.cooldownDurationMs;
    this.baseCooldownMs = opts.cooldownDurationMs;
    this.maxCooldownMs = opts.maxCooldownMs ?? 30 * 60 * 1000; // teto 30min
    this.adaptiveEnabled = opts.adaptiveCooldownEnabled ?? false;
    this.logger = opts.logger;
  }

  /**
   * Chave-mestra de execução: liga/desliga o backoff adaptativo AO VIVO (o toggle do painel acende
   * o pacote de combate; o FailureTracker é construído 1× no boot, então precisa de setter).
   * Idempotente; não mexe no estado de cooldown corrente, só na política dos PRÓXIMOS.
   */
  setAdaptiveCooldown(enabled: boolean): void {
    this.adaptiveEnabled = enabled;
  }

  isAdaptiveCooldownEnabled(): boolean {
    return this.adaptiveEnabled;
  }

  /**
   * #4 — cooldown adaptativo: backoff = base × (1 + cooldowns recentes), limitado pelo teto.
   * Sequência ruim (cooldowns repetidos) → pausa mais longa; recuperação (sucessos) → encolhe.
   */
  private computeAdaptiveCooldownMs(): number {
    return Math.min(this.maxCooldownMs, this.baseCooldownMs * (1 + this._recentCooldowns));
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
    // #4 — recuperação encolhe o backoff (histerese: −1 por sucesso, não zera de vez).
    if (this._recentCooldowns > 0) this._recentCooldowns--;
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
      // #4 — backoff adaptativo: este cooldown conta pra sequência ruim (aumenta o próximo).
      this._recentCooldowns++;
      const adaptiveMs = this.computeAdaptiveCooldownMs();
      // Injeta o adaptativo só se ligado; senão usa a base (mas SEMPRE reporta o adaptativo no stats = "o que faria").
      const effectiveMs = this.adaptiveEnabled ? adaptiveMs : this.baseCooldownMs;
      this.cooldownUntil = Date.now() + effectiveMs;
      this.logger?.error(
        {
          consecutive: this.consecutiveFailures,
          cooldownMs: effectiveMs,
          adaptiveMs,
          adaptiveApplied: this.adaptiveEnabled,
          cooldownUntil: new Date(this.cooldownUntil).toISOString(),
        },
        `🛑 COOLDOWN ATIVADO — ${this.consecutiveFailures} falhas. Pausa de ${effectiveMs / 1000}s${this.adaptiveEnabled ? ' (adaptativo)' : ` (base; adaptativo faria ${adaptiveMs / 1000}s)`}.`,
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
      adaptiveCooldownSec: Math.round(this.computeAdaptiveCooldownMs() / 1000),
      baseCooldownSec: Math.round(this.baseCooldownMs / 1000),
      adaptiveApplied: this.adaptiveEnabled,
    };
  }

  /** Reset manual — apenas pra ops/testes. */
  manualReset(reason: string): void {
    this.logger?.warn({ reason }, `⚠️ FailureTracker MANUAL RESET — ${reason}`);
    this.consecutiveFailures = 0;
    this.cooldownUntil = null;
  }
}
