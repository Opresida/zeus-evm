/**
 * Compound III — discovery completa de positions liquidáveis.
 *
 * Diferente do Aave (subgraph + getUserConfiguration), Compound usa event-scan:
 *   1. Event scan chunked: `Withdraw(src, to, amount)` nos últimos N blocos por Comet
 *      → captura todo borrower que mexeu na position recentemente
 *   2. Multicall3 `isLiquidatable(account)` → filtra liquidáveis ATUAIS
 *   3. Pra cada liquidatable: iterar collaterals do Comet, escolher o top-1
 *      (`collateralBalanceOf(account, asset)` maior wei) — single-collateral assumption
 *   4. Monta CompoundLiquidatablePosition completa
 *
 * Limitação MVP: chunked event scan tem janela curta (~5h Base com free tier).
 * Borrowers silenciosos há mais de 5h não aparecem. Refinar via mempool watching futuro.
 */

import type { Address, PublicClient } from 'viem';

import { COMET_ABI, COMET_WITHDRAW_EVENT_ABI } from './abi';
import type { CometInfo, CompoundCometCache } from './comets';
import { NOOP_LOGGER, type LoggerLike } from '@zeus-evm/aave-discovery';
import type { CompoundLiquidatablePosition } from '../../types';

type AnyPublicClient = PublicClient<any, any>;

/// Free tier dRPC/Alchemy: limita range em ~10k blocos por getLogs.
const FREE_TIER_BLOCK_RANGE_LIMIT = 9_999;

/**
 * Event scan chunked: lista borrowers que emitiram `Withdraw` nos últimos N blocos.
 * Divide em chunks de até 9999 blocos pra free tier compatibility.
 */
export async function fetchCompoundActiveBorrowers(opts: {
  client: AnyPublicClient;
  comet: Address;
  blockLookback?: number;
  chunkSize?: number;
}): Promise<Address[]> {
  const { client, comet, blockLookback = 10_000, chunkSize = FREE_TIER_BLOCK_RANGE_LIMIT } = opts;

  const currentBlock = await client.getBlockNumber();
  const startBlock = currentBlock > BigInt(blockLookback) ? currentBlock - BigInt(blockLookback) : 0n;

  const uniqueBorrowers = new Set<Address>();
  const step = BigInt(chunkSize);

  for (let from = startBlock; from <= currentBlock; from += step + 1n) {
    const to = from + step > currentBlock ? currentBlock : from + step;
    try {
      const logs = await client.getLogs({
        address: comet,
        event: COMET_WITHDRAW_EVENT_ABI,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        if (log.args.src) uniqueBorrowers.add(log.args.src);
      }
    } catch (err) {
      // Falha parcial: chunk falhou mas mantemos o que já temos no Set
      // (próximo tick recupera os perdidos via novo event scan)
    }
  }

  return Array.from(uniqueBorrowers);
}

/**
 * Via Multicall3, filtra borrowers que estão liquidáveis ATUALMENTE.
 * `isLiquidatable` é DEFINITIVO no Compound III (não precisa cálculo de HF off-chain).
 */
export async function findLiquidatableBorrowers(opts: {
  client: AnyPublicClient;
  comet: Address;
  borrowers: Address[];
}): Promise<Address[]> {
  const { client, comet, borrowers } = opts;
  if (borrowers.length === 0) return [];

  const contracts = borrowers.map((borrower) => ({
    address: comet,
    abi: COMET_ABI,
    functionName: 'isLiquidatable' as const,
    args: [borrower] as const,
  }));
  const results = await client.multicall({ contracts, allowFailure: true, batchSize: 100 });

  const liquidatable: Address[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === 'success' && r.result === true) {
      liquidatable.push(borrowers[i]!);
    }
  }
  return liquidatable;
}

/**
 * Pra um borrower liquidatable, descobre qual collateral ele tem mais (top-1 por wei).
 * Itera os collaterals do Comet via `collateralBalanceOf(borrower, asset)`.
 *
 * Limitação MVP: top-1 por wei — não compara valor USD entre collaterals diferentes.
 * Assume single-collateral-dominant position. Refinar via oracle pra multi-collateral.
 */
export async function resolveTopCollateralForBorrower(opts: {
  client: AnyPublicClient;
  cometInfo: CometInfo;
  borrower: Address;
}): Promise<{ asset: Address; balanceWei: bigint } | null> {
  const { client, cometInfo, borrower } = opts;
  if (cometInfo.collaterals.length === 0) return null;

  const calls = cometInfo.collaterals.map((c) => ({
    address: cometInfo.comet,
    abi: COMET_ABI,
    functionName: 'collateralBalanceOf' as const,
    args: [borrower, c.asset] as const,
  }));
  const results = await client.multicall({ contracts: calls, allowFailure: true, batchSize: 50 });

  let top: { asset: Address; balanceWei: bigint } | null = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status !== 'success') continue;
    const balance = BigInt(r.result as bigint | number); // uint128 → bigint
    if (balance === 0n) continue;
    if (!top || balance > top.balanceWei) {
      top = { asset: cometInfo.collaterals[i]!.asset, balanceWei: balance };
    }
  }
  return top;
}

/**
 * Discovery completo pra um Comet: event scan → isLiquidatable → resolveTopCollateral.
 *
 * Retorna positions completas com base/collateral resolvidos.
 */
export async function discoverCompoundLiquidatablePositionsForComet(opts: {
  client: AnyPublicClient;
  cometInfo: CometInfo;
  blockLookback?: number;
  logger?: LoggerLike;
}): Promise<CompoundLiquidatablePosition[]> {
  const { client, cometInfo, blockLookback = 10_000, logger = NOOP_LOGGER } = opts;

  // 1. Event scan
  const candidates = await fetchCompoundActiveBorrowers({
    client,
    comet: cometInfo.comet,
    blockLookback,
  });
  if (candidates.length === 0) {
    logger.info({ comet: cometInfo.name }, `📋 ${cometInfo.name}: 0 borrowers ativos`);
    return [];
  }

  // 2. Filter via isLiquidatable
  const liquidatable = await findLiquidatableBorrowers({
    client,
    comet: cometInfo.comet,
    borrowers: candidates,
  });

  logger.info(
    { comet: cometInfo.name, candidates: candidates.length, liquidatable: liquidatable.length },
    `🎯 ${cometInfo.name}: ${liquidatable.length}/${candidates.length} liquidatable`,
  );

  if (liquidatable.length === 0) return [];

  // 3. Pra cada liquidatable, resolve top collateral
  const positions: CompoundLiquidatablePosition[] = [];
  for (const borrower of liquidatable) {
    try {
      const top = await resolveTopCollateralForBorrower({ client, cometInfo, borrower });
      if (!top) {
        logger.debug({ borrower }, 'Sem collateral resolvido — skip');
        continue;
      }
      const collateralInfo = cometInfo.byCollateral.get(top.asset.toLowerCase());
      if (!collateralInfo) continue;

      positions.push({
        comet: cometInfo.comet,
        cometName: cometInfo.name,
        borrower,
        baseToken: cometInfo.baseToken,
        baseTokenSymbol: cometInfo.baseTokenSymbol,
        baseTokenDecimals: cometInfo.baseTokenDecimals,
        collateralAsset: top.asset,
        collateralAssetSymbol: collateralInfo.symbol,
        collateralAssetDecimals: collateralInfo.decimals,
        collateralBalanceWei: top.balanceWei,
        liquidationFactor: collateralInfo.liquidationFactor,
      });
    } catch (err) {
      logger.warn(
        { borrower, err: err instanceof Error ? err.message : err },
        'Falha ao resolver collateral',
      );
    }
  }

  return positions;
}

/**
 * Discovery em todos os Comets do cache.
 */
export async function discoverCompoundLiquidatablePositions(opts: {
  client: AnyPublicClient;
  cache: CompoundCometCache;
  blockLookback?: number;
  logger?: LoggerLike;
}): Promise<CompoundLiquidatablePosition[]> {
  const { client, cache, blockLookback, logger = NOOP_LOGGER } = opts;
  if (cache.comets.length === 0) return [];

  const allPositions: CompoundLiquidatablePosition[] = [];
  for (const cometInfo of cache.comets) {
    try {
      const positions = await discoverCompoundLiquidatablePositionsForComet({
        client,
        cometInfo,
        blockLookback,
        logger,
      });
      allPositions.push(...positions);
    } catch (err) {
      logger.error(
        { comet: cometInfo.name, err: err instanceof Error ? err.message : err },
        `Discovery falhou pra ${cometInfo.name}`,
      );
    }
  }
  return allPositions;
}
