/**
 * Morpho Blue — discovery de positions liquidáveis (on-chain + cache acumulativo).
 *
 * Por market do cache:
 *   1. Event scan Borrow (filtrado por market id) → borrowers (BorrowerCache reuse)
 *   2. position(id, borrower) + market(id) + oracle.price() via multicall
 *   3. Computa HF off-chain (math.ts) → filtra liquidáveis
 *   4. Monta MorphoLiquidatablePosition
 *
 * Auto-suficiente: zero subgraph. Mesma filosofia do Aave on-chain discovery.
 */

import type { Address, PublicClient } from 'viem';

import { NOOP_LOGGER, type LoggerLike, type BorrowerCache } from '@zeus-evm/aave-discovery';
import { MORPHO_ABI, MORPHO_ORACLE_ABI, MORPHO_BORROW_EVENT_ABI } from './abi';
import type { MorphoMarketCache, MorphoMarketInfo } from './markets';
import { healthFactor, isLiquidatable } from './math';
import type { MorphoLiquidatablePosition } from '../../types';

type AnyPublicClient = PublicClient<any, any>;

const FREE_TIER_BLOCK_RANGE_LIMIT = 9_999;

/**
 * Event scan dos borrowers de UM market (filtrado por id indexed).
 */
export async function fetchMorphoBorrowersOnChain(opts: {
  client: AnyPublicClient;
  morpho: Address;
  marketId: `0x${string}`;
  blockLookback?: number;
}): Promise<Address[]> {
  const { client, morpho, marketId, blockLookback = 10_000 } = opts;
  const currentBlock = await client.getBlockNumber();
  const startBlock = currentBlock > BigInt(blockLookback) ? currentBlock - BigInt(blockLookback) : 0n;
  const step = BigInt(FREE_TIER_BLOCK_RANGE_LIMIT);

  const borrowers = new Set<string>();
  for (let from = startBlock; from <= currentBlock; from += step + 1n) {
    const to = from + step > currentBlock ? currentBlock : from + step;
    try {
      const logs = await client.getLogs({
        address: morpho,
        event: MORPHO_BORROW_EVENT_ABI,
        args: { id: marketId },
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const onBehalf = (log as { args?: { onBehalf?: Address } }).args?.onBehalf;
        if (onBehalf) borrowers.add(onBehalf.toLowerCase());
      }
    } catch {
      // chunk falhou — mantém o que já temos
    }
  }
  return Array.from(borrowers) as Address[];
}

/**
 * Discovery liquidáveis de UM market.
 */
export async function discoverMorphoLiquidatableForMarket(opts: {
  client: AnyPublicClient;
  morpho: Address;
  market: MorphoMarketInfo;
  hfThreshold: number;
  blockLookback?: number;
  borrowerCache?: BorrowerCache;
  logger?: LoggerLike;
}): Promise<MorphoLiquidatablePosition[]> {
  const { client, morpho, market, hfThreshold, blockLookback = 10_000, borrowerCache, logger = NOOP_LOGGER } = opts;

  // 1. Event scan + cache acumulativo
  const scanned = await fetchMorphoBorrowersOnChain({ client, morpho, marketId: market.id, blockLookback });
  let candidates: Address[];
  if (borrowerCache) {
    borrowerCache.add(scanned);
    candidates = borrowerCache.all();
  } else {
    candidates = scanned;
  }
  if (candidates.length === 0) return [];

  // 2. Lê oracle price (1x por market) + market totals (1x)
  const [priceRes, marketRes] = await client.multicall({
    contracts: [
      { address: market.params.oracle, abi: MORPHO_ORACLE_ABI, functionName: 'price' as const },
      { address: morpho, abi: MORPHO_ABI, functionName: 'market' as const, args: [market.id] as const },
    ],
    allowFailure: true,
  });
  if (priceRes?.status !== 'success' || marketRes?.status !== 'success') {
    logger.warn({ market: market.id }, 'Morpho: falha lendo oracle/market — skip');
    return [];
  }
  const collateralPrice = priceRes.result as bigint;
  const mData = marketRes.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  const totalBorrowAssets = mData[2];
  const totalBorrowShares = mData[3];

  // 3. Lê positions de todos candidatos (multicall)
  const posCalls = candidates.map((borrower) => ({
    address: morpho,
    abi: MORPHO_ABI,
    functionName: 'position' as const,
    args: [market.id, borrower] as const,
  }));
  const posResults = await client.multicall({ contracts: posCalls, allowFailure: true, batchSize: 100 });

  const liquidatable: MorphoLiquidatablePosition[] = [];
  const zeroDebt: Address[] = [];
  const hfThresholdWei = BigInt(Math.floor(hfThreshold * 1e18));

  for (let i = 0; i < posResults.length; i++) {
    const r = posResults[i]!;
    if (r.status !== 'success') continue;
    const [, borrowShares, collateral] = r.result as readonly [bigint, bigint, bigint];
    const borrower = candidates[i]!;

    if (borrowShares === 0n) {
      zeroDebt.push(borrower);
      continue;
    }

    const position = { borrowShares, collateral };
    const market2 = { totalBorrowAssets, totalBorrowShares };
    const hf = healthFactor(position, market2, collateralPrice, market.params.lltv);

    // Filtro: HF < threshold (inclui near-liquidation pra calibração)
    if (hf >= hfThresholdWei) continue;
    if (!isLiquidatable(position, market2, collateralPrice, market.params.lltv)) {
      // HF baixo mas ainda não cruzou a linha exata — só conta se realmente liquidável
      if (hfThreshold <= 1.0) continue;
    }

    liquidatable.push({
      marketId: market.id,
      borrower,
      loanToken: market.params.loanToken,
      loanTokenSymbol: market.loanTokenSymbol,
      loanTokenDecimals: market.loanTokenDecimals,
      collateralToken: market.params.collateralToken,
      collateralTokenSymbol: market.collateralTokenSymbol,
      collateralTokenDecimals: market.collateralTokenDecimals,
      oracle: market.params.oracle,
      irm: market.params.irm,
      lltv: market.params.lltv,
      borrowShares,
      collateral,
      collateralPrice,
      healthFactor: hf,
      totalBorrowAssets,
      totalBorrowShares,
    });
  }

  // Auto-poda + persist cache
  if (borrowerCache) {
    if (zeroDebt.length > 0) borrowerCache.remove(zeroDebt);
    borrowerCache.save();
  }

  if (liquidatable.length > 0) {
    logger.info(
      { market: `${market.collateralTokenSymbol}/${market.loanTokenSymbol}`, candidates: candidates.length, liquidatable: liquidatable.length },
      `🎯 Morpho ${market.collateralTokenSymbol}/${market.loanTokenSymbol}: ${liquidatable.length}/${candidates.length} liquidáveis`,
    );
  }
  return liquidatable;
}

/**
 * Discovery em TODOS os markets do cache.
 * `borrowerCacheFor` resolve o cache por market id (1 cache por market).
 */
export async function discoverMorphoLiquidatablePositions(opts: {
  client: AnyPublicClient;
  cache: MorphoMarketCache;
  hfThreshold: number;
  blockLookback?: number;
  borrowerCacheFor?: (marketId: `0x${string}`) => BorrowerCache | undefined;
  logger?: LoggerLike;
}): Promise<MorphoLiquidatablePosition[]> {
  const { client, cache, hfThreshold, blockLookback, borrowerCacheFor, logger = NOOP_LOGGER } = opts;
  if (cache.markets.length === 0) return [];

  const all: MorphoLiquidatablePosition[] = [];
  for (const market of cache.markets) {
    try {
      const positions = await discoverMorphoLiquidatableForMarket({
        client,
        morpho: cache.morpho,
        market,
        hfThreshold,
        blockLookback,
        borrowerCache: borrowerCacheFor?.(market.id),
        logger,
      });
      all.push(...positions);
    } catch (err) {
      logger.error(
        { market: market.id, err: err instanceof Error ? err.message : err },
        `Morpho discovery falhou pra market ${market.collateralTokenSymbol}/${market.loanTokenSymbol}`,
      );
    }
  }
  return all;
}
