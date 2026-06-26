/**
 * Morpho PRE-liquidation — discovery de posições pré-liquidáveis.
 *
 * Por contrato PreLiquidation (do cache da factory):
 *   1. Event scan Borrow (do market) → borrowers candidatos (reuso do Morpho clássico + BorrowerCache).
 *   2. multicall: preLiquidationOracle.price() + market(id) + position(id, borrower)[] + isAuthorized[].
 *   3. Filtra: na faixa 'pre' (preLltv<LTV<LLTV) E o borrower AUTORIZOU o contrato PreLiquidation.
 */

import type { Address, PublicClient } from 'viem';
import { NOOP_LOGGER, type LoggerLike, type BorrowerCache } from '@zeus-evm/aave-discovery';
import { MORPHO_ABI, MORPHO_ORACLE_ABI, MORPHO_IS_AUTHORIZED_ABI } from './abi';
import { fetchMorphoBorrowersOnChain } from '../morpho/discovery';
import { preLiquidationBand } from './math';
import { WAD, ORACLE_PRICE_SCALE, mulDivDown, wDivUp, toAssetsUp } from '../morpho/math';
import type { PreLiquidationContractInfo, PrePosition } from './types';

type AnyPublicClient = PublicClient<any, any>;

/** Discovery pré-liquidáveis de UM contrato PreLiquidation (1 market). */
export async function discoverPreLiquidatableForContract(opts: {
  client: AnyPublicClient;
  morpho: Address;
  info: PreLiquidationContractInfo;
  blockLookback?: number;
  borrowerCache?: BorrowerCache;
  logger?: LoggerLike;
}): Promise<PrePosition[]> {
  const { client, morpho, info, blockLookback = 10_000, borrowerCache, logger = NOOP_LOGGER } = opts;

  const scanned = await fetchMorphoBorrowersOnChain({ client, morpho, marketId: info.marketId, blockLookback });
  let candidates: Address[];
  if (borrowerCache) {
    borrowerCache.add(scanned);
    candidates = borrowerCache.all();
  } else {
    candidates = scanned;
  }
  if (candidates.length === 0) return [];

  // preço (preLiquidationOracle!) + totais do market.
  const [priceRes, marketRes] = await client.multicall({
    contracts: [
      { address: info.preLiquidationOracle, abi: MORPHO_ORACLE_ABI, functionName: 'price' as const },
      { address: morpho, abi: MORPHO_ABI, functionName: 'market' as const, args: [info.marketId] as const },
    ],
    allowFailure: true,
  });
  if (priceRes?.status !== 'success' || marketRes?.status !== 'success') {
    logger.warn({ market: info.marketId }, 'PreLiq: falha lendo oracle/market — skip');
    return [];
  }
  const collateralPrice = priceRes.result as bigint;
  const mData = marketRes.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  const totalBorrowAssets = mData[2];
  const totalBorrowShares = mData[3];

  // positions + isAuthorized(borrower, preLiquidation) em batch.
  const posCalls = candidates.map((b) => ({ address: morpho, abi: MORPHO_ABI, functionName: 'position' as const, args: [info.marketId, b] as const }));
  const authCalls = candidates.map((b) => ({ address: morpho, abi: MORPHO_IS_AUTHORIZED_ABI, functionName: 'isAuthorized' as const, args: [b, info.preLiquidation] as const }));
  const [posResults, authResults] = await Promise.all([
    client.multicall({ contracts: posCalls, allowFailure: true, batchSize: 100 }),
    client.multicall({ contracts: authCalls, allowFailure: true, batchSize: 100 }),
  ]);

  const out: PrePosition[] = [];
  const zeroDebt: Address[] = [];
  for (let i = 0; i < posResults.length; i++) {
    const pr = posResults[i]!;
    const ar = authResults[i]!;
    if (pr.status !== 'success') continue;
    const [, borrowShares, collateral] = pr.result as readonly [bigint, bigint, bigint];
    const borrower = candidates[i]!;
    if (borrowShares === 0n) {
      zeroDebt.push(borrower);
      continue;
    }
    // Autorização é OBRIGATÓRIA pra pré-liquidar (o borrower opta-in no PreLiquidation contract).
    if (ar.status !== 'success' || ar.result !== true) continue;

    const position = { borrowShares, collateral };
    const market = { totalBorrowAssets, totalBorrowShares };
    if (preLiquidationBand(position, market, collateralPrice, info.config) !== 'pre') continue;

    const collateralQuoted = mulDivDown(collateral, collateralPrice, ORACLE_PRICE_SCALE);
    const ltv = wDivUp(toAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares), collateralQuoted);

    out.push({
      preLiquidation: info.preLiquidation,
      marketId: info.marketId,
      borrower,
      loanToken: info.loanToken,
      loanTokenSymbol: info.loanTokenSymbol,
      loanTokenDecimals: info.loanTokenDecimals,
      collateralToken: info.collateralToken,
      collateralTokenDecimals: info.collateralTokenDecimals,
      preLiquidationOracle: info.preLiquidationOracle,
      borrowShares,
      collateral,
      collateralPrice,
      totalBorrowAssets,
      totalBorrowShares,
      ltv,
      config: info.config,
    });
  }

  if (borrowerCache) {
    if (zeroDebt.length > 0) borrowerCache.remove(zeroDebt);
    borrowerCache.save();
  }
  if (out.length > 0) {
    logger.info({ market: info.marketId, candidates: candidates.length, pre: out.length }, `🎯 PreLiq: ${out.length}/${candidates.length} pré-liquidáveis autorizados`);
  }
  return out;
}

/** Discovery em TODOS os contratos PreLiquidation do cache. */
export async function discoverPreLiquidatablePositions(opts: {
  client: AnyPublicClient;
  morpho: Address;
  cache: PreLiquidationContractInfo[];
  blockLookback?: number;
  borrowerCacheFor?: (marketId: `0x${string}`) => BorrowerCache | undefined;
  logger?: LoggerLike;
}): Promise<PrePosition[]> {
  const { client, morpho, cache, blockLookback, borrowerCacheFor, logger = NOOP_LOGGER } = opts;
  const all: PrePosition[] = [];
  for (const info of cache) {
    try {
      const positions = await discoverPreLiquidatableForContract({
        client,
        morpho,
        info,
        blockLookback,
        borrowerCache: borrowerCacheFor?.(info.marketId),
        logger,
      });
      all.push(...positions);
    } catch (err) {
      logger.error({ market: info.marketId, err: err instanceof Error ? err.message : err }, 'PreLiq discovery falhou pra market');
    }
  }
  return all;
}

export { WAD };
