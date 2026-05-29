/**
 * Curadoria + resolução de pool groups pro MIS.
 *
 * Duas fontes de pares:
 *   1. CURADOS manuais (BASE_CURATED_PAIRS) — tese (LSD/stable sub-servidos).
 *   2. DERIVADOS on-chain (deriveTokens.ts) — colaterais dos protocolos de lending.
 *
 * NÃO hardcoda endereços de POOL — define PARES (tokens + decimals) e o resolver
 * descobre os pools on-chain via factory (UniV3 getPool + Aerodrome getPool),
 * filtrando pool morto. Endereços de TOKEN vêm do chain-config (curados) ou
 * direto dos protocolos (derivados) — sempre garantidos.
 */

import type { Address, PublicClient } from 'viem';
import {
  getUniV3PoolAddress,
  getAeroPoolAddress,
  readUniV3PoolState,
  readAeroPoolState,
  getTraderJoePairs,
  readLBPairState,
} from '@zeus-evm/dex-adapters';
import type { PoolGroup, PoolRef } from '@zeus-evm/execution-utils';
import type { ChainConfig } from '@zeus-evm/chain-config';

type AnyPublicClient = PublicClient<any, any>;

/** Retry com backoff curto pra erros transientes de RPC (free tier throttla). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 250): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/** Par curado por CHAVE de token (resolve endereço via chainConfig.tokens). */
interface CuratedPair {
  label: string;
  tokenAKey: string;
  tokenBKey: string;
  decimalsA: number;
  decimalsB: number;
  aeroStable: boolean;
  aeroVolatile: boolean;
}

/** Par já RESOLVIDO (endereços concretos) — fonte única que o resolver consome. */
export interface ResolvedPair {
  label: string;
  tokenA: Address;
  tokenB: Address;
  decimalsA: number;
  decimalsB: number;
  aeroStable: boolean;
  aeroVolatile: boolean;
}

/**
 * Pares iniciais (Base) — foco na tese de ativos ancorados em mercados sub-servidos.
 * Ajustar conforme o MIS revelar quais têm ineficiência persistente.
 */
export const BASE_CURATED_PAIRS: CuratedPair[] = [
  // LSD ancorado ao ETH — divergência de peg, edge de modelo AMM (stable pool no Aero)
  { label: 'cbETH/WETH', tokenAKey: 'cbETH', tokenBKey: 'WETH', decimalsA: 18, decimalsB: 18, aeroStable: true, aeroVolatile: true },
  // Stable/stable — depeg pequeno recorrente
  { label: 'USDC/USDbC', tokenAKey: 'USDC', tokenBKey: 'USDbC', decimalsA: 6, decimalsB: 6, aeroStable: true, aeroVolatile: false },
  { label: 'DAI/USDC', tokenAKey: 'DAI', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: true, aeroVolatile: false },
  { label: 'USDT/USDC', tokenAKey: 'USDT', tokenBKey: 'USDC', decimalsA: 6, decimalsB: 6, aeroStable: true, aeroVolatile: false },
  // Majors — benchmark de liquidez profunda (alta competição, baixo edge — controle)
  { label: 'WETH/USDC', tokenAKey: 'WETH', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: false, aeroVolatile: true },
  { label: 'cbETH/USDC', tokenAKey: 'cbETH', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: false, aeroVolatile: true },
  // Governance — volatilidade + liquidez fragmentada
  { label: 'AERO/WETH', tokenAKey: 'AERO', tokenBKey: 'WETH', decimalsA: 18, decimalsB: 18, aeroStable: false, aeroVolatile: true },
];

/**
 * Pares curados Avalanche (tese: LSD sAVAX + stables + majors).
 * aeroStable/aeroVolatile são irrelevantes aqui (Avalanche não tem Aerodrome) — o 2º venue
 * é o Trader Joe LB, resolvido on-chain via getAllLBPairs.
 */
export const AVALANCHE_CURATED_PAIRS: CuratedPair[] = [
  { label: 'sAVAX/WAVAX', tokenAKey: 'sAVAX', tokenBKey: 'WAVAX', decimalsA: 18, decimalsB: 18, aeroStable: false, aeroVolatile: false },
  { label: 'WAVAX/USDC', tokenAKey: 'WAVAX', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: false, aeroVolatile: false },
  { label: 'sAVAX/USDC', tokenAKey: 'sAVAX', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: false, aeroVolatile: false },
  { label: 'WETH.e/WAVAX', tokenAKey: 'WETH.e', tokenBKey: 'WAVAX', decimalsA: 18, decimalsB: 18, aeroStable: false, aeroVolatile: false },
  { label: 'WETH.e/USDC', tokenAKey: 'WETH.e', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: false, aeroVolatile: false },
  { label: 'USDC/USDT', tokenAKey: 'USDC', tokenBKey: 'USDT', decimalsA: 6, decimalsB: 6, aeroStable: false, aeroVolatile: false },
  { label: 'WBTC.e/USDC', tokenAKey: 'WBTC.e', tokenBKey: 'USDC', decimalsA: 8, decimalsB: 6, aeroStable: false, aeroVolatile: false },
];

/** Resolve as chaves dos pares curados pra endereços (pula par com token ausente). */
export function curatedPairsToResolved(pairs: CuratedPair[], chainConfig: ChainConfig): ResolvedPair[] {
  const out: ResolvedPair[] = [];
  for (const p of pairs) {
    const tokenA = chainConfig.tokens[p.tokenAKey] as Address | undefined;
    const tokenB = chainConfig.tokens[p.tokenBKey] as Address | undefined;
    if (!tokenA || !tokenB) continue;
    out.push({
      label: p.label,
      tokenA,
      tokenB,
      decimalsA: p.decimalsA,
      decimalsB: p.decimalsB,
      aeroStable: p.aeroStable,
      aeroVolatile: p.aeroVolatile,
    });
  }
  return out;
}

/** Dedup de pares por chave não-ordenada de tokens (mantém o primeiro = curado tem prioridade). */
export function dedupPairs(pairs: ResolvedPair[]): ResolvedPair[] {
  const seen = new Set<string>();
  const out: ResolvedPair[] = [];
  for (const p of pairs) {
    const [a, b] = [p.tokenA.toLowerCase(), p.tokenB.toLowerCase()].sort();
    const key = `${a}-${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Resolve os pools on-chain de cada par e monta os PoolGroups pro MIS.
 * Pula par se < 2 pools resolvidos (sem comparação possível).
 */
export async function resolvePoolGroups(opts: {
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  pairs: ResolvedPair[];
  logger?: { info: (o: unknown, m?: string) => void; debug?: (o: unknown, m?: string) => void };
}): Promise<PoolGroup[]> {
  const { client, chainConfig, pairs, logger } = opts;
  const uniFactory = chainConfig.uniswapV3?.factory as Address | undefined;
  const aeroFactory = chainConfig.aerodrome?.factory as Address | undefined;
  const tjFactory = chainConfig.traderJoe?.lbFactory as Address | undefined;
  const feeTiers = chainConfig.uniswapV3?.feeTiers ?? [100, 500, 3000, 10000];

  const groups: PoolGroup[] = [];

  for (const pair of pairs) {
    const { tokenA, tokenB } = pair;
    const pools: PoolRef[] = [];

    // UniV3: 1 pool por fee tier (resolve via factory + filtra pool morto)
    // try/catch por pool: erro transiente de RPC pula o pool, não derruba o boot.
    if (uniFactory) {
      for (const fee of feeTiers) {
        try {
          const pool = await withRetry(() => getUniV3PoolAddress({ client, factory: uniFactory, tokenA, tokenB, fee }));
          if (!pool) continue;
          // Filtro de liquidez: descarta pool não-inicializado/morto (gera preço lixo)
          const state = await withRetry(() => readUniV3PoolState({ client, pool }));
          if (!state || state.sqrtPriceX96 === 0n || state.liquidity === 0n) {
            logger?.debug?.({ pair: pair.label, fee }, 'UniV3 pool morto/vazio — descartado');
            continue;
          }
          pools.push({ dex: 'univ3', pool, label: `UniV3-${fee}`, fee });
        } catch (err) {
          logger?.debug?.({ pair: pair.label, fee, err: err instanceof Error ? err.message : err }, 'UniV3 resolve falhou (transiente) — pula');
        }
      }
    }

    // Aerodrome: stable e/ou volatile (resolve via factory + filtra pool morto)
    if (aeroFactory) {
      const aeroVariants: Array<{ stable: boolean; label: string }> = [];
      if (pair.aeroStable) aeroVariants.push({ stable: true, label: 'Aero-stable' });
      if (pair.aeroVolatile) aeroVariants.push({ stable: false, label: 'Aero-volatile' });
      for (const v of aeroVariants) {
        try {
          const pool = await withRetry(() => getAeroPoolAddress({ client, factory: aeroFactory, tokenA, tokenB, stable: v.stable }));
          if (!pool) continue;
          const state = await withRetry(() => readAeroPoolState({ client, pool }));
          // Descarta pool morto/desbalanceado (reserve ~0 num lado = preço lixo na curva)
          if (!state || state.reserve0 === 0n || state.reserve1 === 0n) {
            logger?.debug?.({ pair: pair.label, variant: v.label }, 'Aero pool morto/vazio — descartado');
            continue;
          }
          pools.push({ dex: 'aerodrome', pool, label: v.label, stable: v.stable });
        } catch (err) {
          logger?.debug?.({ pair: pair.label, variant: v.label, err: err instanceof Error ? err.message : err }, 'Aero resolve falhou (transiente) — pula');
        }
      }
    }

    // Trader Joe v2.2 Liquidity Book (Avalanche) — resolve todos os bin steps + filtra pool morto
    if (tjFactory) {
      try {
        const lbPairs = await withRetry(() => getTraderJoePairs({ client, factory: tjFactory, tokenA, tokenB }));
        for (const lb of lbPairs) {
          try {
            const state = await withRetry(() => readLBPairState({ client, pair: lb.pair }));
            if (!state || (state.reserveX === 0n && state.reserveY === 0n)) {
              logger?.debug?.({ pair: pair.label, binStep: lb.binStep }, 'TJ LB pair morto/vazio — descartado');
              continue;
            }
            pools.push({ dex: 'traderjoe', pool: lb.pair, label: `TJ-${lb.binStep}bps`, lbTokenX: state.tokenX });
          } catch (err) {
            logger?.debug?.({ pair: pair.label, binStep: lb.binStep, err: err instanceof Error ? err.message : err }, 'TJ read falhou (transiente) — pula');
          }
        }
      } catch (err) {
        logger?.debug?.({ pair: pair.label, err: err instanceof Error ? err.message : err }, 'TJ resolve falhou (transiente) — pula');
      }
    }

    if (pools.length < 2) {
      logger?.debug?.({ pair: pair.label, pools: pools.length }, 'menos de 2 pools — skip (sem comparação)');
      continue;
    }

    groups.push({
      label: pair.label,
      tokenA,
      tokenB,
      decimalsA: pair.decimalsA,
      decimalsB: pair.decimalsB,
      pools,
    });
    logger?.info?.({ pair: pair.label, pools: pools.length }, `📍 grupo resolvido: ${pair.label} (${pools.length} pools)`);
  }

  return groups;
}
