/**
 * Aave V3 — cache de reserves + configuração estática por chain.
 *
 * Reserves + suas configs (decimals, liquidationBonus, etc) raramente mudam.
 * Cacheamos uma vez no boot pra evitar 10+ chamadas RPC por discovery cycle.
 *
 * Resolver dinâmico:
 *   Pool.ADDRESSES_PROVIDER() → PoolAddressesProvider.getPoolDataProvider() → cached
 */

import type { Address, PublicClient } from 'viem';
import { getAddress } from 'viem';

import {
  POOL_ABI,
  POOL_ADDRESSES_PROVIDER_ABI,
  POOL_ADDRESSES_PROVIDER_BY_CHAIN,
  POOL_DATA_PROVIDER_ABI,
  ERC20_VIEW_ABI,
} from './abi';
import { NOOP_LOGGER, type LoggerLike } from './logger';

type AnyPublicClient = PublicClient<any, any>;

export interface ReserveInfo {
  asset: Address;
  symbol: string;
  decimals: number;
  /** Liquidation bonus em bps (ex: 750 = 7.5%) — NÃO inclui o +10000 base do storage Aave */
  liquidationBonusBps: number;
  /** Liquidation threshold em bps (ex: 8000 = 80%) */
  liquidationThresholdBps: number;
  /** Se ativo. Reserves inativos NÃO podem ser liquidados. */
  isActive: boolean;
  /** Se frozen. Reserves frozen NÃO aceitam novos borrows, mas liquidação ainda funciona. */
  isFrozen: boolean;
}

export interface AaveReservesCache {
  chainId: number;
  poolDataProvider: Address;
  /** Lista de reserves ativos (apenas isActive=true). */
  reserves: Address[];
  /** Index pra lookup rápido: address (lowercased) → ReserveInfo */
  byAddress: Map<string, ReserveInfo>;
}

/**
 * Resolve PoolDataProvider via PoolAddressesProvider on-chain.
 * Mais robusto que hardcoded — funciona mesmo se Aave fizer rotation.
 */
async function resolvePoolDataProvider(
  client: AnyPublicClient,
  chainId: number,
): Promise<Address> {
  const addressesProvider = POOL_ADDRESSES_PROVIDER_BY_CHAIN[chainId];
  if (!addressesProvider) {
    throw new Error(`PoolAddressesProvider não conhecido pra chainId=${chainId}`);
  }

  const pdp = await client.readContract({
    address: addressesProvider,
    abi: POOL_ADDRESSES_PROVIDER_ABI,
    functionName: 'getPoolDataProvider',
  });

  return pdp as Address;
}

/**
 * Build cache completo: lista de reserves + config de cada um.
 * Faz N+2 chamadas: 1 pra resolver PDP + 1 pra getReservesList + N pra config de cada reserve.
 * Pra Base mainnet ~15 reserves, totaliza ~17 calls — feito 1x no boot.
 *
 * @param logger opcional — pino-compatible. Default = no-op silencioso.
 */
export async function buildAaveReservesCache(opts: {
  client: AnyPublicClient;
  poolAddress: Address;
  chainId: number;
  logger?: LoggerLike;
}): Promise<AaveReservesCache> {
  const { client, poolAddress, chainId, logger = NOOP_LOGGER } = opts;

  // 1. Resolver PoolDataProvider
  const poolDataProvider = await resolvePoolDataProvider(client, chainId);
  logger.info({ chainId, poolDataProvider }, `📍 PoolDataProvider resolvido: ${poolDataProvider}`);

  // 2. Listar reserves
  const reservesList = (await client.readContract({
    address: poolAddress,
    abi: POOL_ABI,
    functionName: 'getReservesList',
  })) as readonly Address[];

  logger.info({ chainId, count: reservesList.length }, `📋 Reserves no Pool: ${reservesList.length}`);

  // 3. Pra cada reserve, fetchar config + symbol/decimals via Multicall3
  const configContracts = reservesList.map((asset) => ({
    address: poolDataProvider,
    abi: POOL_DATA_PROVIDER_ABI,
    functionName: 'getReserveConfigurationData' as const,
    args: [asset] as const,
  }));
  const configResults = await client.multicall({ contracts: configContracts, allowFailure: true });

  const symbolContracts = reservesList.map((asset) => ({
    address: asset,
    abi: ERC20_VIEW_ABI,
    functionName: 'symbol' as const,
    args: [] as const,
  }));
  const symbolResults = await client.multicall({ contracts: symbolContracts, allowFailure: true });

  // 4. Montar cache
  const byAddress = new Map<string, ReserveInfo>();
  const activeReserves: Address[] = [];

  for (let i = 0; i < reservesList.length; i++) {
    const asset = getAddress(reservesList[i]!);
    const cfgRes = configResults[i]!;
    const symRes = symbolResults[i]!;

    if (cfgRes.status !== 'success') {
      logger.warn({ asset }, `Falha lendo config do reserve ${asset}`);
      continue;
    }

    const cfg = cfgRes.result as readonly [
      bigint, // decimals
      bigint, // ltv
      bigint, // liquidationThreshold
      bigint, // liquidationBonus (em bps + 10000)
      bigint, // reserveFactor
      boolean, // usageAsCollateralEnabled
      boolean, // borrowingEnabled
      boolean, // stableBorrowRateEnabled
      boolean, // isActive
      boolean, // isFrozen
    ];

    const decimals = Number(cfg[0]);
    const liquidationThreshold = Number(cfg[2]);
    const liquidationBonusRaw = Number(cfg[3]);
    // Aave storage: bonus 10500 = 5% (raw 10500 - 10000 = 500 bps = 5%)
    const liquidationBonusBps = liquidationBonusRaw > 10_000 ? liquidationBonusRaw - 10_000 : 0;
    const isActive = cfg[8];
    const isFrozen = cfg[9];

    const symbol = symRes.status === 'success' ? (symRes.result as string) : 'UNKNOWN';

    const info: ReserveInfo = {
      asset,
      symbol,
      decimals,
      liquidationBonusBps,
      liquidationThresholdBps: liquidationThreshold,
      isActive,
      isFrozen,
    };

    byAddress.set(asset.toLowerCase(), info);
    if (isActive) activeReserves.push(asset);
  }

  logger.info(
    { chainId, active: activeReserves.length, total: reservesList.length },
    `✅ Aave reserves cache: ${activeReserves.length} ativos / ${reservesList.length} total`,
  );

  return {
    chainId,
    poolDataProvider,
    reserves: activeReserves,
    byAddress,
  };
}

export function getReserveInfo(cache: AaveReservesCache, asset: Address): ReserveInfo | undefined {
  return cache.byAddress.get(asset.toLowerCase());
}
