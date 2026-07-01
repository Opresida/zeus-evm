/**
 * Token Safety source — consolida GoPlus Security + CoinGecko em 1 API.
 *
 * Substitui "investigação manual" que eu mencionei antes — o scraper agora
 * verifica automaticamente:
 *   - Honeypot detection (sell bloqueado, slippage maliciosa)
 *   - Buy/sell tax abusivas
 *   - Owner concentration + creator concentration
 *   - Holder count (proxy de maturidade)
 *   - Mintable + proxy contract (vetores de rug)
 *   - CEX listing em Tier-1 exchanges (Binance/Coinbase/Kraken/OKX)
 *
 * Cache em-memória + persistido em disco (TTL 24h por token).
 * Razão: token safety muda devagar (honeypot é honeypot pra sempre), economiza
 * 60-80% de calls quando mesmo token aparece em múltiplos pares.
 *
 * Fontes:
 *   - GoPlus Security: https://api.gopluslabs.io/api/v1/token_security/{chainId}
 *     Free, 30 req/min, sem auth. Aceita até 100 addresses por call.
 *   - CoinGecko free: https://api.coingecko.com/api/v3/coins/{platform}/contract/{address}
 *     Free, 30 req/min sem auth.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

const GOPLUS_BASE_URL = 'https://api.gopluslabs.io/api/v1/token_security';
const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3/coins';

/** Mapeia chainId numérico → identifier CoinGecko platform.
 *  GoPlus aceita chainId direto, então não precisa mapping. */
const COINGECKO_PLATFORM: Record<number, string> = {
  1: 'ethereum',
  10: 'optimistic-ethereum',
  56: 'binance-smart-chain',
  137: 'polygon-pos',
  42161: 'arbitrum-one',
  43114: 'avalanche',
  8453: 'base',
};

/** CEX Tier-1 onde listing = sinal de profissionalismo do token. */
const CEX_TIER1 = new Set([
  'binance',
  'coinbase-exchange',
  'coinbase exchange',
  'kraken',
  'okx',
  'bybit',
  'kucoin',
  'crypto-com',
]);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface TokenSafety {
  address: string;
  chainId: number;
  /** Verificações on-chain (GoPlus). */
  isHoneypot: boolean;
  buyTaxPct: number; // 0-100 (já em %)
  sellTaxPct: number;
  isMintable: boolean;
  isProxy: boolean;
  ownerAddress: string | null;
  ownerBalancePct: number; // 0-100
  creatorBalancePct: number; // 0-100
  holderCount: number;
  /** Top holder % (já desconsiderando known lockers). */
  topHolderPct: number;
  /** True se top holder é uma wallet conhecida como locker (Unicrypt, Team Finance). */
  topHolderIsLocked: boolean;
  isOpenSource: boolean;
  isInDex: boolean;

  // ── Lock de liquidez rico (Tier 0 — do `lp_holders` que já vem na resposta do GoPlus) ──
  /** % do LP travado (soma dos lp_holders com is_locked). 0-100. */
  lpLockedPct: number;
  /** Nome do locker do LP (ex: "UniCrypt", "Team Finance") — null se não travado/desconhecido. */
  lpLockerTag: string | null;
  /** Unix (s) do vencimento mais LONGO do lock do LP — null se sem lock com data. */
  lpUnlockAtSec: number | null;

  /** Verificações market (CoinGecko). */
  hasCoingeckoCoverage: boolean;
  isListedOnCexTier1: boolean;
  cexListings: string[];

  /** Quando esses dados foram coletados. */
  fetchedAt: number;
  /** True se algum source falhou (dados parciais). */
  partial: boolean;
}

interface SafetyCache {
  version: 1;
  entries: Record<string, TokenSafety>; // key = `${chainId}:${addressLowercase}`
}

/** Singleton in-memory cache. Persistido em disk pra sobreviver restart. */
class SafetyCacheManager {
  private cache: SafetyCache = { version: 1, entries: {} };
  private cachePath: string;
  private dirty = false;

  constructor(cacheDir: string) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    this.cachePath = resolve(cacheDir, 'token-safety-cache.json');
    this.load();
  }

  private key(chainId: number, address: string): string {
    return `${chainId}:${address.toLowerCase()}`;
  }

  get(chainId: number, address: string): TokenSafety | null {
    const entry = this.cache.entries[this.key(chainId, address)];
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry;
  }

  set(safety: TokenSafety): void {
    this.cache.entries[this.key(safety.chainId, safety.address)] = safety;
    this.dirty = true;
  }

  private load(): void {
    if (!existsSync(this.cachePath)) return;
    try {
      const raw = readFileSync(this.cachePath, 'utf-8');
      const parsed = JSON.parse(raw) as SafetyCache;
      if (parsed.version === 1 && parsed.entries) {
        this.cache = parsed;
      }
    } catch {
      // Cache corrompido — começa do zero
    }
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 0));
      this.dirty = false;
    } catch {
      // Não-fatal — apenas perdemos persistência
    }
  }

  stats(): { entries: number; freshEntries: number } {
    const now = Date.now();
    const freshEntries = Object.values(this.cache.entries).filter(
      (e) => now - e.fetchedAt <= CACHE_TTL_MS,
    ).length;
    return {
      entries: Object.keys(this.cache.entries).length,
      freshEntries,
    };
  }
}

let singletonCache: SafetyCacheManager | null = null;

export function initCache(cacheDir: string): SafetyCacheManager {
  if (!singletonCache) singletonCache = new SafetyCacheManager(cacheDir);
  return singletonCache;
}

export function flushCache(): void {
  singletonCache?.flush();
}

export function cacheStats(): { entries: number; freshEntries: number } {
  return singletonCache?.stats() ?? { entries: 0, freshEntries: 0 };
}

/**
 * GoPlus pode receber até 100 addresses em 1 call. Batch agressivo economiza calls.
 */
async function fetchGoPlusBatch(
  chainId: number,
  addresses: string[],
  timeoutMs: number,
  logger?: LoggerLike,
): Promise<Map<string, Partial<TokenSafety>>> {
  const results = new Map<string, Partial<TokenSafety>>();
  if (addresses.length === 0) return results;

  // Batch máx 100 por call
  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    batches.push(addresses.slice(i, i + 100));
  }

  for (const batch of batches) {
    const url = `${GOPLUS_BASE_URL}/${chainId}?contract_addresses=${batch.join(',')}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger?.warn({ status: res.status, batchSize: batch.length, chainId }, 'GoPlus HTTP error');
        if (res.status === 429) {
          await sleep(30_000);
        }
        continue;
      }

      const json = (await res.json()) as {
        code?: number;
        message?: string;
        result?: Record<string, Record<string, string | number | unknown>>;
      };

      if (json.code !== 1 || !json.result) {
        logger?.debug({ code: json.code, msg: json.message, chainId }, 'GoPlus response abnormal');
        continue;
      }

      for (const [addr, data] of Object.entries(json.result)) {
        const lowerAddr = addr.toLowerCase();
        results.set(lowerAddr, parseGoPlusToken(data));
      }

      // Rate limit conservador: 30 req/min = 2s entre calls
      await sleep(2_100);
    } catch (err) {
      logger?.warn(
        { err: err instanceof Error ? err.message : err, chainId, batchSize: batch.length },
        'GoPlus fetch falhou',
      );
    }
  }

  return results;
}

function parseGoPlusToken(data: Record<string, string | number | unknown>): Partial<TokenSafety> {
  // GoPlus retorna strings "0"/"1" pra booleans, strings pra numbers
  const num = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseFloat(v) || 0;
    return 0;
  };
  const bool = (v: unknown): boolean => num(v) === 1;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

  // Top holder + se está locked
  const holders = Array.isArray(data['holders']) ? (data['holders'] as Array<Record<string, unknown>>) : [];
  let topHolderPct = 0;
  let topHolderIsLocked = false;
  if (holders.length > 0) {
    const top = holders[0]!;
    topHolderPct = num(top['percent']) * 100; // GoPlus retorna 0.15 = 15%
    topHolderIsLocked = bool(top['is_locked']);
  }

  // Tier 0 — lock de liquidez RICO: usa o `lp_holders` (donos do LP) que já vem na MESMA resposta.
  // % travado (soma), nome do locker (tag) e vencimento mais LONGO (locked_detail.end_time). Zero RPC extra.
  const lpHolders = Array.isArray(data['lp_holders']) ? (data['lp_holders'] as Array<Record<string, unknown>>) : [];
  let lpLockedPct = 0;
  let lpLockerTag: string | null = null;
  let lpUnlockAtSec: number | null = null;
  for (const h of lpHolders) {
    if (!bool(h['is_locked'])) continue;
    lpLockedPct += num(h['percent']) * 100;
    if (!lpLockerTag) lpLockerTag = str(h['tag']);
    const details = Array.isArray(h['locked_detail']) ? (h['locked_detail'] as Array<Record<string, unknown>>) : [];
    for (const d of details) {
      const end = num(d['end_time']);
      if (end > 0 && (lpUnlockAtSec === null || end > lpUnlockAtSec)) lpUnlockAtSec = end;
    }
  }

  return {
    lpLockedPct: Math.min(100, Math.round(lpLockedPct)),
    lpLockerTag,
    lpUnlockAtSec,
    isHoneypot: bool(data['is_honeypot']),
    buyTaxPct: num(data['buy_tax']) * 100,
    sellTaxPct: num(data['sell_tax']) * 100,
    isMintable: bool(data['is_mintable']),
    isProxy: bool(data['is_proxy']),
    ownerAddress: str(data['owner_address']),
    ownerBalancePct: num(data['owner_balance']) * 100,
    creatorBalancePct: num(data['creator_balance']) * 100,
    holderCount: Math.floor(num(data['holder_count'])),
    topHolderPct,
    topHolderIsLocked,
    isOpenSource: bool(data['is_open_source']),
    isInDex: bool(data['is_in_dex']),
  };
}

async function fetchCoinGeckoSingle(
  chainId: number,
  address: string,
  timeoutMs: number,
  logger?: LoggerLike,
): Promise<{ hasCoverage: boolean; isCexTier1: boolean; cexListings: string[] }> {
  const platform = COINGECKO_PLATFORM[chainId];
  if (!platform) {
    return { hasCoverage: false, isCexTier1: false, cexListings: [] };
  }

  const url = `${COINGECKO_BASE_URL}/${platform}/contract/${address.toLowerCase()}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 404) {
      // Token sem cobertura CoinGecko
      return { hasCoverage: false, isCexTier1: false, cexListings: [] };
    }
    if (!res.ok) {
      if (res.status === 429) await sleep(15_000);
      logger?.debug({ status: res.status, address }, 'CoinGecko HTTP error');
      return { hasCoverage: false, isCexTier1: false, cexListings: [] };
    }

    const json = (await res.json()) as {
      tickers?: Array<{ market?: { name?: string; identifier?: string } }>;
    };

    const cexListings: string[] = [];
    let isCexTier1 = false;
    for (const ticker of json.tickers ?? []) {
      const id = (ticker.market?.identifier ?? '').toLowerCase();
      const name = ticker.market?.name ?? '';
      if (id && CEX_TIER1.has(id)) {
        isCexTier1 = true;
        if (!cexListings.includes(name)) cexListings.push(name);
      }
    }

    return { hasCoverage: true, isCexTier1, cexListings };
  } catch (err) {
    logger?.debug(
      { err: err instanceof Error ? err.message : err, address },
      'CoinGecko fetch falhou',
    );
    return { hasCoverage: false, isCexTier1: false, cexListings: [] };
  }
}

export interface FetchSafetyParams {
  chainId: number;
  /** Endereços únicos pra checar. Caller deve deduplicar antes (token pode aparecer em N pares). */
  addresses: string[];
  timeoutMs?: number;
  logger?: LoggerLike;
}

/**
 * Carrega token safety pra um lote de addresses. Usa cache agressivo + GoPlus batch.
 *
 * Estratégia:
 *   1. Tenta cache primeiro (24h TTL) — economiza 60-80% das calls
 *   2. Lotes GoPlus em batch (100 addr por call)
 *   3. CoinGecko per-token (mais lento mas necessário pra CEX listing)
 *   4. Salva tudo no cache antes de retornar
 */
export async function fetchTokenSafety(params: FetchSafetyParams): Promise<TokenSafety[]> {
  const { chainId, addresses, timeoutMs = 15_000, logger } = params;
  if (!singletonCache) throw new Error('TokenSafety cache não inicializado. Chame initCache primeiro.');

  const uniqueAddrs = Array.from(new Set(addresses.map((a) => a.toLowerCase())));
  const results: TokenSafety[] = [];
  const toFetch: string[] = [];

  // 1. Tenta cache
  for (const addr of uniqueAddrs) {
    const cached = singletonCache.get(chainId, addr);
    if (cached) {
      results.push(cached);
    } else {
      toFetch.push(addr);
    }
  }

  if (toFetch.length === 0) {
    logger?.debug({ chainId, cached: results.length }, '🎯 Token safety 100% cache hit');
    return results;
  }

  logger?.info(
    { chainId, fromCache: results.length, toFetch: toFetch.length },
    `🔒 Token safety: ${results.length} cached, fetching ${toFetch.length} novos`,
  );

  // 2. GoPlus batch (rápido, 1 call por 100 tokens)
  const goPlusData = await fetchGoPlusBatch(chainId, toFetch, timeoutMs, logger);

  // 3. CoinGecko per-token (lento, 1 call por token + rate limit)
  for (const addr of toFetch) {
    const goPlus = goPlusData.get(addr);
    const partial = !goPlus;

    // Rate limit conservador 2s entre CoinGecko calls
    const cg = await fetchCoinGeckoSingle(chainId, addr, timeoutMs, logger);
    await sleep(2_100);

    const safety: TokenSafety = {
      address: addr,
      chainId,
      // GoPlus fields (fallback safe se ausente)
      isHoneypot: goPlus?.isHoneypot ?? false,
      buyTaxPct: goPlus?.buyTaxPct ?? 0,
      sellTaxPct: goPlus?.sellTaxPct ?? 0,
      isMintable: goPlus?.isMintable ?? false,
      isProxy: goPlus?.isProxy ?? false,
      ownerAddress: goPlus?.ownerAddress ?? null,
      ownerBalancePct: goPlus?.ownerBalancePct ?? 0,
      creatorBalancePct: goPlus?.creatorBalancePct ?? 0,
      holderCount: goPlus?.holderCount ?? 0,
      topHolderPct: goPlus?.topHolderPct ?? 0,
      topHolderIsLocked: goPlus?.topHolderIsLocked ?? false,
      lpLockedPct: goPlus?.lpLockedPct ?? 0,
      lpLockerTag: goPlus?.lpLockerTag ?? null,
      lpUnlockAtSec: goPlus?.lpUnlockAtSec ?? null,
      isOpenSource: goPlus?.isOpenSource ?? false,
      isInDex: goPlus?.isInDex ?? false,
      // CoinGecko fields
      hasCoingeckoCoverage: cg.hasCoverage,
      isListedOnCexTier1: cg.isCexTier1,
      cexListings: cg.cexListings,
      fetchedAt: Date.now(),
      partial,
    };

    singletonCache.set(safety);
    results.push(safety);
  }

  // 4. Persiste cache pra próxima execução
  singletonCache.flush();

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
