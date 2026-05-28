/**
 * Moonwell — discovery de positions liquidáveis (on-chain + cache acumulativo).
 *
 *   1. Event scan Borrow por mToken → borrowers (BorrowerCache reuse)
 *   2. Comptroller.getAccountLiquidity(borrower) → shortfall > 0 = liquidável
 *   3. Resolve mTokenBorrowed (maior borrowBalance) + mTokenCollateral (maior valor)
 *      via getAccountSnapshot em cada market
 *   4. Monta MoonwellLiquidatablePosition
 *
 * Auto-suficiente: zero subgraph. Mesma filosofia do Aave/Morpho on-chain.
 */

import type { Address, PublicClient } from 'viem';

import { NOOP_LOGGER, type LoggerLike, type BorrowerCache } from '@zeus-evm/aave-discovery';
import { COMPTROLLER_ABI, MTOKEN_ABI, MTOKEN_BORROW_EVENT_ABI } from './abi';
import type { MoonwellMarketCache } from './markets';
import type { MoonwellLiquidatablePosition } from '../../types';

type AnyPublicClient = PublicClient<any, any>;

const FREE_TIER_BLOCK_RANGE_LIMIT = 9_999;

/**
 * Event scan dos borrowers de UM mToken (evento Borrow).
 */
export async function fetchMoonwellBorrowersOnChain(opts: {
  client: AnyPublicClient;
  mToken: Address;
  blockLookback?: number;
}): Promise<Address[]> {
  const { client, mToken, blockLookback = 10_000 } = opts;
  const currentBlock = await client.getBlockNumber();
  const startBlock = currentBlock > BigInt(blockLookback) ? currentBlock - BigInt(blockLookback) : 0n;
  const step = BigInt(FREE_TIER_BLOCK_RANGE_LIMIT);

  const borrowers = new Set<string>();
  for (let from = startBlock; from <= currentBlock; from += step + 1n) {
    const to = from + step > currentBlock ? currentBlock : from + step;
    try {
      const logs = await client.getLogs({
        address: mToken,
        event: MTOKEN_BORROW_EVENT_ABI,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const borrower = (log as { args?: { borrower?: Address } }).args?.borrower;
        if (borrower) borrowers.add(borrower.toLowerCase());
      }
    } catch {
      // chunk falhou — mantém o que já temos
    }
  }
  return Array.from(borrowers) as Address[];
}

/**
 * Resolve mTokenBorrowed (maior dívida) + mTokenCollateral (maior valor seizável)
 * de um borrower, via getAccountSnapshot em cada market.
 */
async function resolveBorrowerMarkets(
  client: AnyPublicClient,
  cache: MoonwellMarketCache,
  borrower: Address,
): Promise<{ borrowedMarket: typeof cache.markets[number]; borrowBalance: bigint; collateralMarket: typeof cache.markets[number] } | null> {
  const calls = cache.markets.map((m) => ({
    address: m.mToken,
    abi: MTOKEN_ABI,
    functionName: 'getAccountSnapshot' as const,
    args: [borrower] as const,
  }));
  const results = await client.multicall({ contracts: calls, allowFailure: true, batchSize: 100 });

  let topBorrow: { market: typeof cache.markets[number]; balance: bigint } | null = null;
  let topCollateral: { market: typeof cache.markets[number]; value: bigint } | null = null;

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status !== 'success') continue;
    const [err, mTokenBalance, borrowBalance, exchangeRate] = r.result as readonly [bigint, bigint, bigint, bigint];
    if (err !== 0n) continue;
    const market = cache.markets[i]!;

    if (borrowBalance > 0n && (!topBorrow || borrowBalance > topBorrow.balance)) {
      topBorrow = { market, balance: borrowBalance };
    }
    // valor do colateral ≈ mTokenBalance × exchangeRate / 1e18 (underlying wei)
    if (mTokenBalance > 0n) {
      const collateralValue = (mTokenBalance * exchangeRate) / 10n ** 18n;
      if (collateralValue > 0n && (!topCollateral || collateralValue > topCollateral.value)) {
        topCollateral = { market, value: collateralValue };
      }
    }
  }

  if (!topBorrow || !topCollateral) return null;
  return { borrowedMarket: topBorrow.market, borrowBalance: topBorrow.balance, collateralMarket: topCollateral.market };
}

/**
 * Discovery completo Moonwell.
 */
export async function discoverMoonwellLiquidatablePositions(opts: {
  client: AnyPublicClient;
  cache: MoonwellMarketCache;
  blockLookback?: number;
  borrowerCacheFor?: (mToken: Address) => BorrowerCache | undefined;
  logger?: LoggerLike;
}): Promise<MoonwellLiquidatablePosition[]> {
  const { client, cache, blockLookback = 10_000, borrowerCacheFor, logger = NOOP_LOGGER } = opts;
  if (cache.markets.length === 0) return [];

  // 1. Coleta candidatos de todos os markets (event scan + cache acumulativo)
  const allBorrowers = new Set<string>();
  for (const market of cache.markets) {
    const scanned = await fetchMoonwellBorrowersOnChain({ client, mToken: market.mToken, blockLookback });
    const cacheForMarket = borrowerCacheFor?.(market.mToken);
    if (cacheForMarket) {
      cacheForMarket.add(scanned);
      cacheForMarket.save();
      for (const b of cacheForMarket.all()) allBorrowers.add(b.toLowerCase());
    } else {
      for (const b of scanned) allBorrowers.add(b.toLowerCase());
    }
  }
  const candidates = Array.from(allBorrowers) as Address[];
  if (candidates.length === 0) return [];

  // 2. getAccountLiquidity → shortfall > 0 (multicall)
  const liqCalls = candidates.map((borrower) => ({
    address: cache.comptroller,
    abi: COMPTROLLER_ABI,
    functionName: 'getAccountLiquidity' as const,
    args: [borrower] as const,
  }));
  const liqResults = await client.multicall({ contracts: liqCalls, allowFailure: true, batchSize: 100 });

  const underwater: Array<{ borrower: Address; shortfall: bigint }> = [];
  for (let i = 0; i < liqResults.length; i++) {
    const r = liqResults[i]!;
    if (r.status !== 'success') continue;
    const [err, , shortfall] = r.result as readonly [bigint, bigint, bigint];
    if (err === 0n && shortfall > 0n) {
      underwater.push({ borrower: candidates[i]!, shortfall });
    }
  }

  if (underwater.length === 0) return [];
  logger.info(
    { candidates: candidates.length, underwater: underwater.length },
    `🎯 Moonwell: ${underwater.length}/${candidates.length} com shortfall`,
  );

  // 3. Resolve markets (borrowed + collateral) de cada underwater
  const positions: MoonwellLiquidatablePosition[] = [];
  for (const { borrower, shortfall } of underwater) {
    try {
      const resolved = await resolveBorrowerMarkets(client, cache, borrower);
      if (!resolved) continue;
      const { borrowedMarket, borrowBalance, collateralMarket } = resolved;
      positions.push({
        borrower,
        mTokenBorrowed: borrowedMarket.mToken,
        borrowedUnderlying: borrowedMarket.underlying,
        borrowedSymbol: borrowedMarket.underlyingSymbol,
        borrowedDecimals: borrowedMarket.underlyingDecimals,
        mTokenCollateral: collateralMarket.mToken,
        collateralUnderlying: collateralMarket.underlying,
        collateralSymbol: collateralMarket.underlyingSymbol,
        collateralDecimals: collateralMarket.underlyingDecimals,
        borrowBalanceWei: borrowBalance,
        shortfallWei: shortfall,
        closeFactorMantissa: cache.closeFactorMantissa,
        liquidationIncentiveMantissa: cache.liquidationIncentiveMantissa,
      });
    } catch (err) {
      logger.warn({ borrower, err: err instanceof Error ? err.message : err }, 'Moonwell: falha resolvendo markets');
    }
  }
  return positions;
}
