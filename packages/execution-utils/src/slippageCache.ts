/**
 * Cache de quotes UniswapV3 por (tokenIn, tokenOut, fee, amountIn) com TTL.
 *
 * Razão: o calculator faz 10-15 sample amounts × 4 fee tiers = 40-60 quotes UniV3
 * por position. Em ticks consecutivos (60s), MUITOS quotes são pra mesmas
 * (tokenIn, tokenOut, fee) com amounts iguais ou próximos.
 *
 * Cache simples por chave exata (não interpolação) — barato e seguro.
 * TTL 60s = mesma cadência do polling. Se preço mover mais que isso, próximo tick recalcula.
 *
 * Speedup esperado: ~50-70% redução em chamadas RPC pra QuoterV2 em workloads
 * com positions recorrentes (caso normal em 2 semanas DRY_RUN observação).
 *
 * Limitações:
 * - Não interpola. Amount diferente = cache miss. Bom porque slippage é não-linear.
 * - Não invalida em block-tip change. Aceita staleness até TTL.
 * - In-memory only. Reset no restart do liquidator.
 */

import type { Address } from 'viem';
import type { Quote, QuoteResult } from '@zeus-evm/dex-adapters';

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  quote: Quote;
  cachedAt: number;
}

/** Chave canônica do cache. Lowercased pra match insensitive. */
function makeKey(tokenIn: Address, tokenOut: Address, fee: number, amountIn: bigint): string {
  return `${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}|${fee}|${amountIn.toString()}`;
}

export class SlippageCache {
  private store = new Map<string, CacheEntry>();
  private ttlMs: number;
  // Métricas pra observabilidade
  private _hits = 0;
  private _misses = 0;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Lookup. Retorna Quote se hit (não expirou), undefined se miss. */
  get(tokenIn: Address, tokenOut: Address, fee: number, amountIn: bigint): Quote | undefined {
    const key = makeKey(tokenIn, tokenOut, fee, amountIn);
    const entry = this.store.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }
    const age = Date.now() - entry.cachedAt;
    if (age > this.ttlMs) {
      this.store.delete(key);
      this._misses++;
      return undefined;
    }
    this._hits++;
    return entry.quote;
  }

  /** Armazena Quote bem-sucedida. Não cacheia erros (sempre re-tenta). */
  set(tokenIn: Address, tokenOut: Address, fee: number, amountIn: bigint, quote: Quote): void {
    const key = makeKey(tokenIn, tokenOut, fee, amountIn);
    this.store.set(key, { quote, cachedAt: Date.now() });
  }

  /** Remove entradas expiradas. Chamar periodicamente (ex: 1×/min). */
  pruneExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.cachedAt > this.ttlMs) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Métricas de hit rate pra log/dashboard. */
  stats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      size: this.store.size,
      hitRate: total === 0 ? 0 : this._hits / total,
    };
  }

  /** Reset métricas (útil pra log periódico). */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
  }
}

/** Singleton compartilhado entre Aave e Compound calculators. */
export const slippageCache = new SlippageCache();

/**
 * Wrapper sobre quoteUniswapV3 com cache.
 *
 * Recebe a função `fetcher` por DI (não importa diretamente) pra evitar dep cíclica
 * e simplificar testes.
 */
export async function cachedQuoteUniswapV3<TQuoteParams extends {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
}>(
  params: TQuoteParams,
  fetcher: (p: TQuoteParams) => Promise<QuoteResult>,
): Promise<QuoteResult> {
  const { tokenIn, tokenOut, fee, amountIn } = params;
  const hit = slippageCache.get(tokenIn, tokenOut, fee, amountIn);
  if (hit) return hit;

  const result = await fetcher(params);
  // Só cacheia Quote bem-sucedida (QuoteResult pode ser QuoteError)
  if ('amountOut' in result) {
    slippageCache.set(tokenIn, tokenOut, fee, amountIn, result);
  }
  return result;
}
