/**
 * On-chain competition source — mede densidade de bots/searchers por par.
 *
 * Estratégia:
 *   1. Pra cada pool do par, fetch últimos N blocos de Swap events via getLogs
 *   2. Extrai endereços únicos que originaram swaps (sender + recipient)
 *   3. Classifica cada endereço como "bot" ou "EOA" via heurísticas
 *   4. Score 0-100 inverso à densidade de bots:
 *      - 0 bots únicos     → 100 (água azul perfeita)
 *      - 1-2 bots          → 70
 *      - 3-5 bots          → 40
 *      - 6+ bots           → 10
 *
 * Heurísticas de bot (sem fetch extra de bytecode):
 *   - sender !== recipient (caller é contrato wrapper)
 *   - Multiple Swap events na MESMA tx (arb multi-step)
 *   - Mesmo endereço aparece ≥3x no range
 *
 * Heurísticas que dão sinal mais forte mas exigem RPC extra (pulados no MVP):
 *   - getCode(sender) — distingue EOA vs contract definitive
 *   - Priority fee alto vs baseFee
 *
 * RPC: usa fallback transport igual liquidator. Free tier suporta.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, fallback, parseAbiItem, type Address, type PublicClient } from 'viem';
import { base, optimism, arbitrum, polygon, avalanche } from 'viem/chains';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

type AnyPublicClient = PublicClient<any, any>;

const COMPETITION_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Swap event signatures por DEX. */
const SWAP_EVENT_UNIV3 = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
);
const SWAP_EVENT_VELODROME_AERODROME = parseAbiItem(
  'event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)',
);

/** Quantos blocos pra trás scanner — ~3h em chain de 2s/block (Base). */
const DEFAULT_BLOCK_RANGE = 5_000;

export interface CompetitionInput {
  chainId: number;
  /** Pools do par (extracted do GeckoTerminal). Cada pool tem address + dexId. */
  pools: Array<{ poolAddress: string; dexId: string }>;
  /** RPC URL primária da chain. */
  rpcUrl: string;
  /** RPC URL fallback (opt). */
  rpcUrlFallback?: string;
  /** Blocos pra scanear pra trás. Default 5000. */
  blockRange?: number;
  logger?: LoggerLike;
}

export interface CompetitionStats {
  totalUniqueTraders: number;
  estimatedBots: number;
  estimatedEoas: number;
  totalSwaps: number;
  blocksScanned: number;
  /** True se algum getLogs falhou — score é menos confiável. */
  partial: boolean;
}

/**
 * Resolve viem chain config baseado em chainId.
 */
function resolveViemChain(chainId: number): any {
  switch (chainId) {
    case 8453: return base;
    case 10: return optimism;
    case 42161: return arbitrum;
    case 137: return polygon;
    case 43114: return avalanche;
    default: throw new Error(`chainId ${chainId} não mapeada em onchainCompetition`);
  }
}

/**
 * Identifica se o swap event vem de DEX UniV3-like ou Velodrome-like.
 * Retorna ABI correto pro getLogs.
 */
function pickEventForDex(dexId: string): typeof SWAP_EVENT_UNIV3 | typeof SWAP_EVENT_VELODROME_AERODROME {
  const lower = dexId.toLowerCase();
  if (
    lower.includes('aerodrome') ||
    lower.includes('velodrome') ||
    lower.includes('quickswap-v2') ||
    lower.includes('sushiswap-v2') ||
    lower.includes('uniswap-v2')
  ) {
    return SWAP_EVENT_VELODROME_AERODROME;
  }
  // Default UniV3-like (Camelot V3 / Algebra também usam mesmo schema)
  return SWAP_EVENT_UNIV3;
}

/**
 * Heurística de bot detection — combina múltiplos sinais sem fetch extra.
 * Retorna true se address é PROVAVELMENTE bot.
 */
function classifyTrader(
  address: string,
  swapsBySender: Map<string, number>,
  swapsByTxHash: Map<string, number>,
  txHashesBySender: Map<string, Set<string>>,
): boolean {
  const swapCount = swapsBySender.get(address) ?? 0;

  // Sinal 1: alto volume de swaps no range (≥3 swaps = bot ativo)
  if (swapCount >= 3) return true;

  // Sinal 2: address apareceu em tx com múltiplos Swap events (arb multi-step)
  const txHashes = txHashesBySender.get(address);
  if (txHashes) {
    for (const txHash of txHashes) {
      const swapsInTx = swapsByTxHash.get(txHash) ?? 0;
      if (swapsInTx >= 2) return true;
    }
  }

  // Senão, considera EOA normal
  return false;
}

/**
 * Scaneia logs Swap dos pools do par, conta traders únicos + classifica como bot.
 */
export async function fetchCompetitionStats(input: CompetitionInput): Promise<CompetitionStats> {
  const { chainId, pools, rpcUrl, rpcUrlFallback, logger } = input;
  const blockRange = input.blockRange ?? DEFAULT_BLOCK_RANGE;

  if (pools.length === 0) {
    return {
      totalUniqueTraders: 0,
      estimatedBots: 0,
      estimatedEoas: 0,
      totalSwaps: 0,
      blocksScanned: 0,
      partial: true,
    };
  }

  const transports = rpcUrlFallback
    ? fallback([http(rpcUrl), http(rpcUrlFallback)], { retryCount: 1 })
    : http(rpcUrl);

  const client: AnyPublicClient = createPublicClient({
    chain: resolveViemChain(chainId),
    transport: transports,
  });

  let partial = false;
  let toBlock: bigint;
  try {
    toBlock = await client.getBlockNumber();
  } catch (err) {
    logger?.warn({ err: err instanceof Error ? err.message : err, chainId }, 'getBlockNumber falhou — competition skip');
    return {
      totalUniqueTraders: 0,
      estimatedBots: 0,
      estimatedEoas: 0,
      totalSwaps: 0,
      blocksScanned: 0,
      partial: true,
    };
  }
  const fromBlock = toBlock - BigInt(blockRange);

  // Acumula stats de TODOS pools do par
  const swapsBySender = new Map<string, number>();
  const swapsByTxHash = new Map<string, number>();
  const txHashesBySender = new Map<string, Set<string>>();
  let totalSwaps = 0;

  for (const pool of pools) {
    try {
      const eventAbi = pickEventForDex(pool.dexId);
      const logs = await client.getLogs({
        address: pool.poolAddress as Address,
        event: eventAbi as any,
        fromBlock,
        toBlock,
      });

      for (const log of logs as Array<{ args: any; transactionHash: string }>) {
        const sender = (log.args.sender as string | undefined)?.toLowerCase();
        const recipient = (log.args.recipient as string | undefined)?.toLowerCase()
          ?? (log.args.to as string | undefined)?.toLowerCase();
        const txHash = log.transactionHash;

        if (!txHash) continue;
        totalSwaps++;
        swapsByTxHash.set(txHash, (swapsByTxHash.get(txHash) ?? 0) + 1);

        for (const addr of [sender, recipient]) {
          if (!addr) continue;
          swapsBySender.set(addr, (swapsBySender.get(addr) ?? 0) + 1);
          if (!txHashesBySender.has(addr)) txHashesBySender.set(addr, new Set());
          txHashesBySender.get(addr)!.add(txHash);
        }
      }
    } catch (err) {
      logger?.debug(
        { err: err instanceof Error ? err.message : err, pool: pool.poolAddress, chainId },
        'getLogs falhou pra pool',
      );
      partial = true;
    }
  }

  // Classifica cada trader único
  const allTraders = new Set([...swapsBySender.keys()]);
  let estimatedBots = 0;
  for (const trader of allTraders) {
    if (classifyTrader(trader, swapsBySender, swapsByTxHash, txHashesBySender)) {
      estimatedBots++;
    }
  }

  return {
    totalUniqueTraders: allTraders.size,
    estimatedBots,
    estimatedEoas: allTraders.size - estimatedBots,
    totalSwaps,
    blocksScanned: blockRange,
    partial,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Cache layer — economiza calls quando mesmo par aparece em runs consecutivos
// ────────────────────────────────────────────────────────────────────────────

interface CompetitionCacheEntry {
  stats: CompetitionStats;
  fetchedAt: number;
}

interface CompetitionCache {
  version: 1;
  entries: Record<string, CompetitionCacheEntry>;
}

let cacheManager: { path: string; data: CompetitionCache; dirty: boolean } | null = null;

function pairKeyForCache(chainId: number, pairId: string): string {
  return `${chainId}:${pairId.toUpperCase()}`;
}

export function initCompetitionCache(cacheDir: string): void {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const path = resolve(cacheDir, 'competition-cache.json');
  let data: CompetitionCache = { version: 1, entries: {} };
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as CompetitionCache;
      if (parsed.version === 1 && parsed.entries) data = parsed;
    } catch {
      // ignora cache corrompido
    }
  }
  cacheManager = { path, data, dirty: false };
}

export function getCachedCompetition(chainId: number, pairId: string): CompetitionStats | null {
  if (!cacheManager) return null;
  const key = pairKeyForCache(chainId, pairId);
  const entry = cacheManager.data.entries[key];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > COMPETITION_CACHE_TTL_MS) return null;
  return entry.stats;
}

export function setCachedCompetition(chainId: number, pairId: string, stats: CompetitionStats): void {
  if (!cacheManager) return;
  cacheManager.data.entries[pairKeyForCache(chainId, pairId)] = {
    stats,
    fetchedAt: Date.now(),
  };
  cacheManager.dirty = true;
}

export function flushCompetitionCache(): void {
  if (!cacheManager || !cacheManager.dirty) return;
  try {
    writeFileSync(cacheManager.path, JSON.stringify(cacheManager.data));
    cacheManager.dirty = false;
  } catch {
    // não-fatal
  }
}

export function competitionCacheStats(): { entries: number; freshEntries: number } {
  if (!cacheManager) return { entries: 0, freshEntries: 0 };
  const now = Date.now();
  const all = Object.values(cacheManager.data.entries);
  return {
    entries: all.length,
    freshEntries: all.filter((e) => now - e.fetchedAt <= COMPETITION_CACHE_TTL_MS).length,
  };
}
