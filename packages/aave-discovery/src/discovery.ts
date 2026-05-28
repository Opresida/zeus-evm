/**
 * Aave V3 — discovery completa de positions liquidáveis.
 *
 * Pipeline:
 *   1. Subgraph: lista candidatos (users com borrowedReservesCount > 0)
 *   2. Multicall3 on-chain: getUserAccountData pra cada → filtra HF < threshold
 *   3. Pra cada at-risk: resolver par (collateralAsset, debtAsset) dominante
 *      via getUserReserveData iterando reserves (pegamos top-1 por wei balance)
 *   4. Monta AaveLiquidatablePosition completo (com decimals/symbol/bonus do cache)
 *
 * IMPORTANTE — simplificações conscientes do MVP:
 *   - "Top-1 por wei balance" não compara USD entre assets diferentes (1 WETH vs 1000 USDC
 *     em wei são números muito diferentes). Pra produção: multiplicar por oracle price.
 *     Pra MVP: assume single-collateral-single-debt positions, que cobre 80%+ dos casos.
 *   - HF threshold default 1.05 inclui "near liquidation" pra calibração. Em prod = 1.0.
 */

import type { Address, PublicClient } from 'viem';

import { POOL_ABI, POOL_DATA_PROVIDER_ABI, POOL_BORROW_EVENT_ABI } from './abi';
import { NOOP_LOGGER, type LoggerLike } from './logger';
import type { AaveReservesCache } from './reserves';
import { getReserveInfo } from './reserves';
import type { AaveCandidate, AaveLiquidatablePosition } from './types';

const GATEWAY_URL = 'https://gateway.thegraph.com/api';

type AnyPublicClient = PublicClient<any, any>;

/** Subgraph query: lista candidatos com debt > 0 ordenados por complexidade. */
export async function fetchAaveV3Candidates(opts: {
  apiKey: string;
  subgraphId: string;
  first?: number;
  skip?: number;
}): Promise<AaveCandidate[]> {
  const { apiKey, subgraphId, first = 100, skip = 0 } = opts;
  if (!apiKey) throw new Error('THEGRAPH_API_KEY obrigatório');

  const query = `
    query Candidates($first: Int!, $skip: Int!) {
      users(
        first: $first
        skip: $skip
        where: { borrowedReservesCount_gt: 0 }
        orderBy: borrowedReservesCount
        orderDirection: desc
      ) { id borrowedReservesCount }
    }
  `;

  const res = await fetch(`${GATEWAY_URL}/${apiKey}/subgraphs/id/${subgraphId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { first, skip } }),
  });

  if (!res.ok) throw new Error(`Subgraph HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { users: Array<{ id: string; borrowedReservesCount: number }> };
    errors?: Array<{ message: string }>;
  };
  if (json.errors) throw new Error(`Subgraph errors: ${json.errors.map((e) => e.message).join('; ')}`);
  if (!json.data) return [];
  return json.data.users.map((u) => ({
    user: u.id as Address,
    borrowedReservesCount: u.borrowedReservesCount,
  }));
}

/**
 * Health Factor (1e18 = 1.0) on-chain — filtragem de candidatos.
 * Faz batch via Multicall3.
 */
export async function fetchHealthFactorsBatch(opts: {
  client: AnyPublicClient;
  poolAddress: Address;
  users: Address[];
}): Promise<Map<string, { hf: bigint; totalDebtBase: bigint; totalCollateralBase: bigint }>> {
  const { client, poolAddress, users } = opts;
  if (users.length === 0) return new Map();

  const contracts = users.map((user) => ({
    address: poolAddress,
    abi: POOL_ABI,
    functionName: 'getUserAccountData' as const,
    args: [user] as const,
  }));

  const results = await client.multicall({ contracts, allowFailure: true, batchSize: 100 });

  const map = new Map<string, { hf: bigint; totalDebtBase: bigint; totalCollateralBase: bigint }>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status !== 'success') continue;
    const data = r.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
    // [totalCollateralBase, totalDebtBase, availableBorrowsBase, liquidationThreshold, ltv, healthFactor]
    map.set(users[i]!.toLowerCase(), {
      totalCollateralBase: data[0],
      totalDebtBase: data[1],
      hf: data[5],
    });
  }
  return map;
}

/**
 * Resolve o par (collateralAsset, debtAsset) dominante de um borrower at-risk.
 * Itera reserves ATIVOS, faz getUserReserveData em batch via Multicall3,
 * escolhe TOP-1 collateral (maior currentATokenBalance) e TOP-1 debt
 * (maior currentVariableDebt + currentStableDebt).
 *
 * Retorna null se borrower não tem collateral OR não tem debt (não liquidable).
 */
export async function resolveBorrowerPositionPair(opts: {
  client: AnyPublicClient;
  cache: AaveReservesCache;
  borrower: Address;
}): Promise<{
  collateralAsset: Address;
  collateralBalanceWei: bigint;
  debtAsset: Address;
  debtBalanceWei: bigint;
} | null> {
  const { client, cache, borrower } = opts;
  if (cache.reserves.length === 0) return null;

  const contracts = cache.reserves.map((asset) => ({
    address: cache.poolDataProvider,
    abi: POOL_DATA_PROVIDER_ABI,
    functionName: 'getUserReserveData' as const,
    args: [asset, borrower] as const,
  }));

  const results = await client.multicall({ contracts, allowFailure: true, batchSize: 50 });

  let topCollateral: { asset: Address; balance: bigint } | null = null;
  let topDebt: { asset: Address; balance: bigint } | null = null;

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status !== 'success') continue;
    const data = r.result as readonly [
      bigint, // currentATokenBalance
      bigint, // currentStableDebt
      bigint, // currentVariableDebt
      bigint, // principalStableDebt
      bigint, // scaledVariableDebt
      bigint, // stableBorrowRate
      bigint, // liquidityRate
      number, // stableRateLastUpdated (uint40)
      boolean, // usageAsCollateralEnabled
    ];

    const asset = cache.reserves[i]!;
    const aTokenBalance = data[0];
    const stableDebt = data[1];
    const variableDebt = data[2];
    const usageAsCollateral = data[8];
    const totalDebt = stableDebt + variableDebt;

    if (aTokenBalance > 0n && usageAsCollateral) {
      if (!topCollateral || aTokenBalance > topCollateral.balance) {
        topCollateral = { asset, balance: aTokenBalance };
      }
    }
    if (totalDebt > 0n) {
      if (!topDebt || totalDebt > topDebt.balance) {
        topDebt = { asset, balance: totalDebt };
      }
    }
  }

  if (!topCollateral || !topDebt) return null;

  return {
    collateralAsset: topCollateral.asset,
    collateralBalanceWei: topCollateral.balance,
    debtAsset: topDebt.asset,
    debtBalanceWei: topDebt.balance,
  };
}

/**
 * Multi-collateral evaluation (Grupo B do bloqueio mainnet).
 *
 * Retorna TODOS os pares (collateral_i, debt_j) viáveis pra liquidation.
 * Em borrowers com múltiplos collaterals/debts, top-1 por wei descarta opções
 * que podem ter MAIS profit (collateral menor mas com bonus maior, pool mais
 * líquido, fee tier melhor, oracle drift positivo, etc).
 *
 * Quem decide o melhor par: o calculator é rodado pra cada combinação e o
 * pipeline escolhe o de maior profit em USD.
 *
 * Multi-chain: mesma ABI Aave V3 em todas chains (Base/Arb/OP/Polygon/Avalanche).
 *
 * Custo: 1 multicall (igual top-1). Sem RPC adicional.
 */
export async function resolveAllBorrowerPositionPairs(opts: {
  client: AnyPublicClient;
  cache: AaveReservesCache;
  borrower: Address;
}): Promise<Array<{
  collateralAsset: Address;
  collateralBalanceWei: bigint;
  debtAsset: Address;
  debtBalanceWei: bigint;
}>> {
  const { client, cache, borrower } = opts;
  if (cache.reserves.length === 0) return [];

  const contracts = cache.reserves.map((asset) => ({
    address: cache.poolDataProvider,
    abi: POOL_DATA_PROVIDER_ABI,
    functionName: 'getUserReserveData' as const,
    args: [asset, borrower] as const,
  }));

  const results = await client.multicall({ contracts, allowFailure: true, batchSize: 50 });

  const collaterals: Array<{ asset: Address; balance: bigint }> = [];
  const debts: Array<{ asset: Address; balance: bigint }> = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status !== 'success') continue;
    const data = r.result as readonly [
      bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean,
    ];

    const asset = cache.reserves[i]!;
    const aTokenBalance = data[0];
    const stableDebt = data[1];
    const variableDebt = data[2];
    const usageAsCollateral = data[8];
    const totalDebt = stableDebt + variableDebt;

    if (aTokenBalance > 0n && usageAsCollateral) {
      collaterals.push({ asset, balance: aTokenBalance });
    }
    if (totalDebt > 0n) {
      debts.push({ asset, balance: totalDebt });
    }
  }

  if (collaterals.length === 0 || debts.length === 0) return [];

  // Produto cartesiano: todos pares possíveis
  const pairs: Array<{
    collateralAsset: Address;
    collateralBalanceWei: bigint;
    debtAsset: Address;
    debtBalanceWei: bigint;
  }> = [];
  for (const c of collaterals) {
    for (const d of debts) {
      pairs.push({
        collateralAsset: c.asset,
        collateralBalanceWei: c.balance,
        debtAsset: d.asset,
        debtBalanceWei: d.balance,
      });
    }
  }
  return pairs;
}

/**
 * Discovery completo: subgraph → HF filter → par dominante → AaveLiquidatablePosition[]
 *
 * Retorna apenas positions com HF < `hfThreshold` E par (collateral, debt) resolvido.
 *
 * @param logger opcional — pino-compatible. Default = no-op silencioso.
 */
export async function discoverAaveLiquidatablePositions(opts: {
  client: AnyPublicClient;
  poolAddress: Address;
  apiKey: string;
  subgraphId: string;
  cache: AaveReservesCache;
  hfThreshold: number;
  maxCandidates?: number;
  /**
   * Grupo B — Multi-collateral evaluation.
   * Quando true, emite N positions por borrower (1 por par collateral×debt).
   * Caller (calculator) avalia cada um e pipeline escolhe o de maior profit.
   * Default false (compat com comportamento atual).
   */
  evaluateAllPairs?: boolean;
  logger?: LoggerLike;
}): Promise<AaveLiquidatablePosition[]> {
  const {
    client,
    poolAddress,
    apiKey,
    subgraphId,
    cache,
    hfThreshold,
    maxCandidates = 200,
    evaluateAllPairs = false,
    logger = NOOP_LOGGER,
  } = opts;

  // 1. Subgraph candidatos
  const candidates = await fetchAaveV3Candidates({ apiKey, subgraphId, first: maxCandidates });
  if (candidates.length === 0) return [];
  logger.debug({ count: candidates.length }, `Subgraph candidates: ${candidates.length}`);

  // 2. HF batch on-chain
  const users = candidates.map((c) => c.user);
  const hfMap = await fetchHealthFactorsBatch({ client, poolAddress, users });

  const hfThresholdBigInt = BigInt(Math.floor(hfThreshold * 1e18));
  const atRisk: { user: Address; hf: bigint }[] = [];

  for (const user of users) {
    const data = hfMap.get(user.toLowerCase());
    if (!data) continue;
    if (data.hf === 0n) continue;
    if (data.hf < hfThresholdBigInt) {
      atRisk.push({ user, hf: data.hf });
    }
  }

  logger.info(
    { candidates: candidates.length, atRisk: atRisk.length, threshold: hfThreshold },
    `🎯 At-risk (HF < ${hfThreshold}): ${atRisk.length}/${candidates.length}`,
  );

  if (atRisk.length === 0) return [];

  // 3. Pra cada at-risk: resolver par(es) (sequencial pra não saturar RPC)
  const positions: AaveLiquidatablePosition[] = [];
  for (const { user, hf } of atRisk) {
    try {
      const pairs = evaluateAllPairs
        ? await resolveAllBorrowerPositionPairs({ client, cache, borrower: user })
        : await resolveBorrowerPositionPair({ client, cache, borrower: user }).then((p) => p ? [p] : []);

      if (pairs.length === 0) {
        logger.debug({ user, hf: hf.toString() }, `Sem par (collateral,debt) resolvido — skip`);
        continue;
      }

      for (const pair of pairs) {
        const colInfo = getReserveInfo(cache, pair.collateralAsset);
        const debtInfo = getReserveInfo(cache, pair.debtAsset);
        if (!colInfo || !debtInfo) {
          logger.warn({ user, pair }, `Reserve info ausente no cache pra par`);
          continue;
        }

        positions.push({
          borrower: user,
          collateralAsset: pair.collateralAsset,
          debtAsset: pair.debtAsset,
          totalDebtWei: pair.debtBalanceWei,
          totalCollateralWei: pair.collateralBalanceWei,
          healthFactor: hf,
          liquidationBonusBps: colInfo.liquidationBonusBps,
          debtAssetDecimals: debtInfo.decimals,
          collateralAssetDecimals: colInfo.decimals,
          debtAssetSymbol: debtInfo.symbol,
          collateralAssetSymbol: colInfo.symbol,
        });
      }

      if (evaluateAllPairs && pairs.length > 1) {
        logger.debug(
          { user, pairs: pairs.length },
          `Multi-collateral: ${pairs.length} pares emitidos pra ${user}`,
        );
      }
    } catch (err) {
      logger.warn(
        { user, err: err instanceof Error ? err.message : err },
        `Falha ao resolver position de ${user}`,
      );
    }
  }

  logger.info(
    { resolved: positions.length, atRisk: atRisk.length },
    `📦 Positions completas resolvidas: ${positions.length}/${atRisk.length}`,
  );

  return positions;
}

/// Free tier dRPC/Alchemy: limita range em ~10k blocos por getLogs.
const FREE_TIER_BLOCK_RANGE_LIMIT = 9_999;

/**
 * Discovery on-chain (SEM subgraph) — Opção 3 da Doutrina.
 *
 * Lista borrowers via eventos `Borrow` do Pool nos últimos N blocos (chunked pra
 * free tier), depois reusa o MESMO pipeline (HF batch + resolve pairs) do discovery
 * subgraph-based. Elimina dependência de subgraph de terceiro — funciona pra
 * Seamless e qualquer Aave fork.
 *
 * Mesma estratégia do Compound discovery (event scan chunked).
 */
export async function fetchAaveBorrowersOnChain(opts: {
  client: AnyPublicClient;
  poolAddress: Address;
  blockLookback?: number;
  chunkSize?: number;
}): Promise<Address[]> {
  const { client, poolAddress, blockLookback = 10_000, chunkSize = FREE_TIER_BLOCK_RANGE_LIMIT } = opts;

  const currentBlock = await client.getBlockNumber();
  const startBlock = currentBlock > BigInt(blockLookback) ? currentBlock - BigInt(blockLookback) : 0n;

  const uniqueBorrowers = new Set<string>();
  const step = BigInt(chunkSize);

  for (let from = startBlock; from <= currentBlock; from += step + 1n) {
    const to = from + step > currentBlock ? currentBlock : from + step;
    try {
      const logs = await client.getLogs({
        address: poolAddress,
        event: POOL_BORROW_EVENT_ABI,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        // onBehalfOf é quem carrega a dívida (não o `user` que pode ser um relayer)
        const onBehalfOf = (log as { args?: { onBehalfOf?: Address } }).args?.onBehalfOf;
        if (onBehalfOf) uniqueBorrowers.add(onBehalfOf.toLowerCase());
      }
    } catch {
      // Falha parcial: chunk falhou mas mantemos o que já temos (próximo tick recupera)
    }
  }

  return Array.from(uniqueBorrowers) as Address[];
}

/**
 * Discovery completo on-chain: event scan → HF batch → resolve par(es).
 *
 * Interface idêntica ao `discoverAaveLiquidatablePositions` mas SEM subgraph.
 * Usado pra Aave forks (Seamless) que não têm subgraph no decentralized network.
 */
export async function discoverAaveLiquidatablePositionsOnChain(opts: {
  client: AnyPublicClient;
  poolAddress: Address;
  cache: AaveReservesCache;
  hfThreshold: number;
  blockLookback?: number;
  evaluateAllPairs?: boolean;
  logger?: LoggerLike;
}): Promise<AaveLiquidatablePosition[]> {
  const {
    client,
    poolAddress,
    cache,
    hfThreshold,
    blockLookback = 10_000,
    evaluateAllPairs = false,
    logger = NOOP_LOGGER,
  } = opts;

  // 1. Event scan on-chain (substitui o subgraph)
  const candidates = await fetchAaveBorrowersOnChain({ client, poolAddress, blockLookback });
  if (candidates.length === 0) {
    logger.info('📋 On-chain discovery: 0 borrowers no event scan');
    return [];
  }
  logger.debug({ count: candidates.length }, `On-chain candidates: ${candidates.length}`);

  // 2. HF batch on-chain (reusa fetchHealthFactorsBatch)
  const hfMap = await fetchHealthFactorsBatch({ client, poolAddress, users: candidates });
  const hfThresholdBigInt = BigInt(Math.floor(hfThreshold * 1e18));
  const atRisk: { user: Address; hf: bigint }[] = [];
  for (const user of candidates) {
    const data = hfMap.get(user.toLowerCase());
    if (!data || data.hf === 0n) continue;
    if (data.hf < hfThresholdBigInt) atRisk.push({ user, hf: data.hf });
  }

  logger.info(
    { candidates: candidates.length, atRisk: atRisk.length, threshold: hfThreshold },
    `🎯 On-chain at-risk (HF < ${hfThreshold}): ${atRisk.length}/${candidates.length}`,
  );

  if (atRisk.length === 0) return [];

  // 3-5. Resolve par(es) — MESMA lógica do discovery subgraph-based
  const positions: AaveLiquidatablePosition[] = [];
  for (const { user, hf } of atRisk) {
    try {
      const pairs = evaluateAllPairs
        ? await resolveAllBorrowerPositionPairs({ client, cache, borrower: user })
        : await resolveBorrowerPositionPair({ client, cache, borrower: user }).then((p) => (p ? [p] : []));

      for (const pair of pairs) {
        const colInfo = getReserveInfo(cache, pair.collateralAsset);
        const debtInfo = getReserveInfo(cache, pair.debtAsset);
        if (!colInfo || !debtInfo) continue;
        positions.push({
          borrower: user,
          collateralAsset: pair.collateralAsset,
          debtAsset: pair.debtAsset,
          totalDebtWei: pair.debtBalanceWei,
          totalCollateralWei: pair.collateralBalanceWei,
          healthFactor: hf,
          liquidationBonusBps: colInfo.liquidationBonusBps,
          debtAssetDecimals: debtInfo.decimals,
          collateralAssetDecimals: colInfo.decimals,
          debtAssetSymbol: debtInfo.symbol,
          collateralAssetSymbol: colInfo.symbol,
        });
      }
    } catch (err) {
      logger.warn(
        { user, err: err instanceof Error ? err.message : err },
        `On-chain: falha ao resolver position de ${user}`,
      );
    }
  }

  logger.info(
    { resolved: positions.length, atRisk: atRisk.length },
    `📦 On-chain positions resolvidas: ${positions.length}/${atRisk.length}`,
  );
  return positions;
}
