/**
 * Execução do Motor 2 — adaptador PoolGroup → TargetPair + busca de oportunidade FRESCA.
 *
 * O MIS detecta ineficiências persistentes (quais pares têm edge). Pra EXECUTAR, reusamos o
 * caminho do detector: `findCrossDexArb` cota FRESCO no bloco atual (resolve a staleness — o scan
 * é a cada ~12s) e devolve uma `CrossDexOpportunity` pronta pro builder/simulador/dispatcher.
 *
 * NÃO usa lista fixa: o universo de pares vem da descoberta (curados + derivados on-chain),
 * o ranking de persistência escolhe os melhores, e aqui a gente re-cota e dispara em cima deles.
 */

import type { Address, PublicClient } from 'viem';
import { parseUnits } from 'viem';
import type { TargetPair } from '@zeus-evm/chain-config';
import type { PoolGroup } from '@zeus-evm/execution-utils';
import { findCrossDexArb, type CrossDexOpportunity } from '@zeus-evm/strategy';

type AnyPublicClient = PublicClient<any, any>;

/**
 * Constrói um `TargetPair` (entrada do `findCrossDexArb`) a partir de um `PoolGroup` resolvido.
 * Fee tiers UniV3 e flags Aerodrome vêm dos pools REAIS já resolvidos (não hardcode).
 */
export function groupToTargetPair(
  group: PoolGroup,
  estimatedUsdValueA: number,
  estimatedUsdValueB: number,
): TargetPair {
  // Canônico UniV3 = dex 'univ3' SEM venue (forks Pancake/Sushi carregam venue + quoter/router próprios).
  const uniFees = group.pools
    .filter((p) => p.dex === 'univ3' && !p.venue && typeof p.fee === 'number')
    .map((p) => p.fee as number);
  const aerodromeStable = group.pools.some((p) => p.dex === 'aerodrome' && p.stable === true);
  const aerodromeVolatile = group.pools.some((p) => p.dex === 'aerodrome' && p.stable === false);

  // Forks UniV3: agrupa por venue → {quoterV2, swapRouter, feeTiers}.
  const forkMap = new Map<string, { venue: string; quoterV2: Address; swapRouter: Address; feeTiers: number[] }>();
  for (const p of group.pools) {
    if (p.dex !== 'univ3' || !p.venue || !p.router || !p.quoter || typeof p.fee !== 'number') continue;
    const entry = forkMap.get(p.venue) ?? { venue: p.venue, quoterV2: p.quoter, swapRouter: p.router, feeTiers: [] };
    entry.feeTiers.push(p.fee);
    forkMap.set(p.venue, entry);
  }
  const univ3Forks = [...forkMap.values()].map((f) => ({ ...f, feeTiers: [...new Set(f.feeTiers)] }));

  // DEXes UniV2 resolvidos.
  const univ2Dexes = group.pools
    .filter((p) => p.dex === 'univ2' && p.router && p.venue)
    .map((p) => ({ venue: p.venue as string, router: p.router as Address }));

  // Slipstream: tickSpacings com pool vivo + endereços (todos os refs slipstream compartilham quoter/router).
  const slipPools = group.pools.filter((p) => p.dex === 'slipstream' && p.router && p.quoter && typeof p.tickSpacing === 'number');
  const slipstream =
    slipPools.length > 0
      ? {
          quoter: slipPools[0]!.quoter as Address,
          swapRouter: slipPools[0]!.router as Address,
          tickSpacings: [...new Set(slipPools.map((p) => p.tickSpacing as number))],
        }
      : undefined;

  return {
    id: group.label,
    tokenA: group.tokenA,
    tokenB: group.tokenB,
    decimalsA: group.decimalsA,
    decimalsB: group.decimalsB,
    category: 'volatile-volatile', // só pra logs/filtros; não afeta a execução
    estimatedUsdValueA,
    estimatedUsdValueB,
    uniswapV3FeeTiers: [...new Set(uniFees)],
    aerodromeStable,
    aerodromeVolatile,
    ...(univ3Forks.length > 0 ? { univ3Forks } : {}),
    ...(univ2Dexes.length > 0 ? { univ2Dexes } : {}),
    ...(slipstream ? { slipstream } : {}),
  };
}

export interface FindArbOpts {
  client: AnyPublicClient;
  group: PoolGroup;
  /** Notional alvo em USD (sizing). O findCrossDexArb cota nesse tamanho. */
  notionalUsd: number;
  /** Preço USD de 1 tokenA (pra converter notional → amountInA). */
  estimatedUsdValueA: number;
  /** Preço USD de 1 tokenB. */
  estimatedUsdValueB: number;
  blockNumber?: bigint;
}

/**
 * Re-cota FRESCO um grupo e devolve a melhor `CrossDexOpportunity` (ou null).
 * Converte o notional USD → amountInA usando o preço estimado do tokenA.
 */
export async function findFreshArb(opts: FindArbOpts): Promise<CrossDexOpportunity | null> {
  const { client, group, notionalUsd, estimatedUsdValueA, estimatedUsdValueB, blockNumber } = opts;
  if (estimatedUsdValueA <= 0 || !Number.isFinite(estimatedUsdValueA)) return null;

  const pair = groupToTargetPair(group, estimatedUsdValueA, estimatedUsdValueB);
  const amountInA = parseUnits((notionalUsd / estimatedUsdValueA).toFixed(group.decimalsA), group.decimalsA);
  if (amountInA <= 0n) return null;

  return findCrossDexArb({ client, pair, amountInA, blockNumber });
}

/** Token A da oportunidade (= asset do flashloan). */
export function flashloanAssetOf(opp: CrossDexOpportunity): Address {
  return opp.pair.tokenA;
}
