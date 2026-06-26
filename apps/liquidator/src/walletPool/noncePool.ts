/**
 * Nonce-pool (cuidado #4 do Humberto) — nonce LOCAL por sender.
 *
 * Com N senders disparando em paralelo, deixar cada tx buscar o nonce no RPC causa corrida
 * ("nonce too low" — exatamente o que vimos no deploy). Aqui cada sender tem um contador local:
 * sincroniza 1x com a chain (getTransactionCount 'pending'), depois ALOCA sequencial sem ida ao RPC.
 * Em erro de nonce, `invalidate` força re-sync na próxima.
 *
 * Por-sender (não global): nonce é por-conta. Mapa address→próximo-nonce.
 */

import type { Address } from 'viem';

export class NoncePool {
  private next = new Map<string, number>();
  private needsSync = new Set<string>();

  /** Semeia o nonce-base de um sender (= getTransactionCount(addr, 'pending')). */
  sync(address: Address, onchainPendingNonce: number): void {
    const key = address.toLowerCase();
    this.next.set(key, onchainPendingNonce);
    this.needsSync.delete(key);
  }

  /** True se o sender ainda não foi sincronizado ou foi invalidado (precisa re-sync antes de alocar). */
  requiresSync(address: Address): boolean {
    const key = address.toLowerCase();
    return !this.next.has(key) || this.needsSync.has(key);
  }

  /**
   * Aloca o próximo nonce do sender e incrementa o contador local. Lança se não sincronizado
   * (fail-safe: nunca chutar nonce). Cheque `requiresSync` antes e semeie via `sync`.
   */
  allocate(address: Address): number {
    const key = address.toLowerCase();
    if (this.requiresSync(address)) {
      throw new Error(`NoncePool: sender ${address} não sincronizado — chame sync() antes de allocate()`);
    }
    const n = this.next.get(key)!;
    this.next.set(key, n + 1);
    return n;
  }

  /**
   * Marca o sender pra re-sync (ex: recebeu "nonce too low/high", tx dropada). A próxima
   * `requiresSync` retorna true → o caller re-lê getTransactionCount e chama sync().
   */
  invalidate(address: Address): void {
    this.needsSync.add(address.toLowerCase());
  }

  /** Próximo nonce que será alocado (sem incrementar) — pra logs/debug. */
  peek(address: Address): number | undefined {
    return this.next.get(address.toLowerCase());
  }
}
