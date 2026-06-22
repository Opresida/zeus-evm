/**
 * Position Deduplication — evita submeter mesma liquidation 2x em ticks consecutivos.
 *
 * Cenário: discovery loop roda a cada 60s. Position liquidável aparece no tick T.
 * Bot submete tx, ainda não confirmou. Tick T+1 (60s depois) ainda vê a position
 * (subgraph ainda não indexou) e tenta liquidar 2x.
 *
 * Resultado sem dedup: tx 2 reverte porque borrower não é mais liquidable
 * (foi liquidado pela tx 1), gas perdido.
 *
 * Solução: Map<positionKey, DedupEntry> com TTL.
 *
 * Estados rastreados:
 *   - 'pending'   — tx submetida, aguardando receipt. Bloqueia novo dispatch.
 *   - 'confirmed' — tx confirmou recentemente. Bloqueia por TTL curto.
 *   - 'failed'    — tx reverteu recentemente. Bloqueia por TTL curto (evita re-tentar).
 *
 * Chave composta: `${chain}:${protocol}:${borrower}` (Aave) ou
 *                 `${chain}:${protocol}:${comet}:${borrower}` (Compound).
 *
 * Estado transitório — não persiste em disco (restart limpa).
 */

import type { Address } from 'viem';

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export type DedupStatus = 'pending' | 'confirmed' | 'failed';

interface DedupEntry {
  status: DedupStatus;
  timestamp: number;
  txHash?: `0x${string}`;
  reason?: string;
}

export interface DedupStats {
  total: number;
  pending: number;
  confirmed: number;
  failed: number;
  /** Supressões acumuladas (lifetime) por status — "quase-duplicados evitados" (Fase 6). */
  suppressed: { pending: number; confirmed: number; failed: number };
}

export interface DedupTrackerOpts {
  /** Quanto tempo (ms) uma tx pendente fica bloqueando. Se receipt não chega nesse tempo,
   *  liberamos pra retry (assume tx travada/perdida). */
  pendingTimeoutMs: number;
  /** Quanto tempo (ms) uma tx confirmed/failed fica bloqueando re-tentativa.
   *  Após esse TTL, position pode ser re-processada (subgraph deve ter atualizado). */
  recentTtlMs: number;
  logger?: LoggerLike;
}

/** Builders de chave canonical pra dedup.
 *  `market` distingue Aave V3 core de forks (seamless, etc) — evita colisão de
 *  dedup quando o mesmo borrower existe em múltiplos mercados Aave-compatíveis. */
export function aavePositionKey(chain: string, borrower: Address, market = 'aave-v3'): string {
  return `${chain}:${market}:${borrower.toLowerCase()}`;
}

export function compoundPositionKey(chain: string, comet: Address, borrower: Address): string {
  return `${chain}:compound-v3:${comet.toLowerCase()}:${borrower.toLowerCase()}`;
}

/** Morpho: market isolado por id — key inclui marketId pra não colidir entre markets. */
export function morphoPositionKey(chain: string, marketId: string, borrower: Address): string {
  return `${chain}:morpho-blue:${marketId.toLowerCase()}:${borrower.toLowerCase()}`;
}

export class PositionDedupTracker {
  private store = new Map<string, DedupEntry>();
  private pendingTimeoutMs: number;
  private recentTtlMs: number;
  private logger: LoggerLike | undefined;
  /** Contagem lifetime de supressões por status (Fase 6 — visibilidade do que foi evitado). */
  private suppressedCount: Record<DedupStatus, number> = { pending: 0, confirmed: 0, failed: 0 };

  constructor(opts: DedupTrackerOpts) {
    this.pendingTimeoutMs = opts.pendingTimeoutMs;
    this.recentTtlMs = opts.recentTtlMs;
    this.logger = opts.logger;
  }

  /**
   * Verifica se position está bloqueada (em alguma das 3 fases).
   * Retorna status atual OU null se livre pra processar.
   * Tem side-effect de limpar entradas expiradas.
   */
  check(key: string): { blocked: true; status: DedupStatus; ageMs: number } | { blocked: false } {
    const entry = this.store.get(key);
    if (!entry) return { blocked: false };

    const age = Date.now() - entry.timestamp;
    const ttl = entry.status === 'pending' ? this.pendingTimeoutMs : this.recentTtlMs;

    if (age >= ttl) {
      // TTL expirou — libera. Pra pending que travou: provavelmente tx perdida, retry OK.
      this.store.delete(key);
      this.logger?.debug(
        { key, status: entry.status, ageMs: age },
        `dedup TTL expirou — ${key} liberado`,
      );
      return { blocked: false };
    }

    // Supressão real (um quase-duplicado evitado) — contabiliza pra métrica.
    this.suppressedCount[entry.status]++;
    return { blocked: true, status: entry.status, ageMs: age };
  }

  /** Marca position como pending (tx submetida, aguardando receipt). */
  markPending(key: string, txHash: `0x${string}`): void {
    this.store.set(key, { status: 'pending', timestamp: Date.now(), txHash });
    this.logger?.debug({ key, txHash }, `🟡 dedup PENDING: ${key}`);
  }

  /** Marca como confirmed (tx liquidou). Bloqueia retry por TTL curto. */
  markConfirmed(key: string, txHash: `0x${string}`): void {
    this.store.set(key, { status: 'confirmed', timestamp: Date.now(), txHash });
    this.logger?.debug({ key, txHash }, `🟢 dedup CONFIRMED: ${key}`);
  }

  /** Marca como failed (tx reverteu). Bloqueia retry por TTL curto. */
  markFailed(key: string, reason: string, txHash?: `0x${string}`): void {
    this.store.set(key, { status: 'failed', timestamp: Date.now(), txHash, reason });
    this.logger?.debug({ key, txHash, reason }, `🔴 dedup FAILED: ${key}`);
  }

  /** Garbage collect entries expiradas. Chamar oportunisticamente. */
  pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      const ttl = entry.status === 'pending' ? this.pendingTimeoutMs : this.recentTtlMs;
      if (now - entry.timestamp >= ttl) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  stats(): DedupStats {
    let pending = 0;
    let confirmed = 0;
    let failed = 0;
    for (const entry of this.store.values()) {
      if (entry.status === 'pending') pending++;
      else if (entry.status === 'confirmed') confirmed++;
      else failed++;
    }
    return { total: this.store.size, pending, confirmed, failed, suppressed: { ...this.suppressedCount } };
  }

  /** Pra testes / ops em emergência. */
  manualClear(): void {
    this.store.clear();
  }
}
