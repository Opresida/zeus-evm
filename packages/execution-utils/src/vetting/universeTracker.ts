/**
 * VettingUniverseTracker — guarda o verdict ATUAL de cada token (por motor) e detecta TRANSIÇÕES
 * (entrou/saiu) pra emitir evento só quando MUDA (anti-flicker). `snapshot()` alimenta o heartbeat
 * (tela "Tokens"). Mesmo espírito do StrategyStatsTracker, mas por token.
 */

import type { TokenVerdict, VettingMotor } from './tokenVetting';

export interface VettedEntry {
  token: string;
  symbol: string;
  motor: VettingMotor;
  verdict: 'pass' | 'reject';
  reason: string;
  exitDex?: string;
  liquidityUsd: number;
  locked: boolean;
}

export class VettingUniverseTracker {
  private byKey = new Map<string, VettedEntry>();

  private key(token: string, motor: VettingMotor): string {
    return `${token.toLowerCase()}:${motor}`;
  }

  /**
   * Registra um verdict. Retorna a transição ('entered'/'exited') SE o verdict mudou vs o anterior
   * (ou é novo), senão null (sem mudança → o caller não emite, evitando spam a cada tick).
   */
  record(v: TokenVerdict): 'entered' | 'exited' | null {
    const k = this.key(v.token, v.motor);
    const prev = this.byKey.get(k);
    const entry: VettedEntry = {
      token: v.token,
      symbol: v.symbol,
      motor: v.motor,
      verdict: v.verdict,
      reason: v.reasons[0] ?? '',
      exitDex: v.checks.exitRoute.dex,
      liquidityUsd: v.checks.liquidityFloor.usd,
      locked: v.checks.lockStatus.locked,
    };
    this.byKey.set(k, entry);
    if (prev && prev.verdict === v.verdict) return null; // sem mudança
    return v.verdict === 'pass' ? 'entered' : 'exited';
  }

  /** Universo atual (todos os tokens vetados, por motor) — pro heartbeat. */
  snapshot(): VettedEntry[] {
    return Array.from(this.byKey.values());
  }

  /** Verdict atual de um token/motor (null se nunca vetado). */
  current(token: string, motor: VettingMotor): VettedEntry | null {
    return this.byKey.get(this.key(token, motor)) ?? null;
  }
}
