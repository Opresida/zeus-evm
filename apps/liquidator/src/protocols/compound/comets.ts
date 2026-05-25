/**
 * Compound III — cache de info de Comets (markets) + collaterals suportados.
 *
 * Diferente do Aave (1 Pool, N reserves), Compound tem N Comets (1 por base token),
 * cada Comet com sua própria lista de collaterals (assets).
 *
 * Cache contém:
 *   - baseToken + decimals (USDC/WETH/etc)
 *   - lista de collateralAssets ativos
 *   - decimals + symbol de cada collateral
 *   - liquidationFactor por collateral (porcentagem do valor que vira disponível)
 */

import type { Address, PublicClient } from 'viem';
import { getAddress } from 'viem';

import { COMET_ABI } from './abi';
import { ERC20_VIEW_ABI } from '@zeus-evm/aave-discovery';
import { NOOP_LOGGER, type LoggerLike } from '@zeus-evm/aave-discovery';

type AnyPublicClient = PublicClient<any, any>;

export interface CometCollateralInfo {
  asset: Address;
  symbol: string;
  decimals: number;
  /** liquidationFactor em 1e18 scale (ex: 9e17 = 0.9 = 90% disponível pra liquidação) */
  liquidationFactor: bigint;
  /** Decimais do asset (escala unitária do Comet) */
  scale: bigint;
}

export interface CometInfo {
  /** Endereço do Comet (cUSDCv3, cWETHv3, etc) */
  comet: Address;
  /** Nome legível pra logs ("cUSDCv3") */
  name: string;
  /** Base token (USDC, WETH) */
  baseToken: Address;
  baseTokenSymbol: string;
  baseTokenDecimals: number;
  /** Lista de collaterals suportados */
  collaterals: CometCollateralInfo[];
  /** Index by collateral address (lowercased) */
  byCollateral: Map<string, CometCollateralInfo>;
}

export interface CompoundCometCache {
  chainId: number;
  /** Lista de Comets monitorados na chain */
  comets: CometInfo[];
}

/**
 * Build cache pra um único Comet: descobre baseToken + numAssets + cada asset via Multicall3.
 */
export async function buildCometInfo(opts: {
  client: AnyPublicClient;
  comet: Address;
  cometName: string;
  logger?: LoggerLike;
}): Promise<CometInfo> {
  const { client, comet, cometName, logger = NOOP_LOGGER } = opts;

  // 1. baseToken + numAssets em paralelo
  const [baseToken, numAssetsRaw] = await Promise.all([
    client.readContract({ address: comet, abi: COMET_ABI, functionName: 'baseToken' }),
    client.readContract({ address: comet, abi: COMET_ABI, functionName: 'numAssets' }),
  ]);
  const numAssets = Number(numAssetsRaw);

  // 2. Symbol + decimals do baseToken
  const [baseSymbol, baseDecimals] = await Promise.all([
    client.readContract({ address: baseToken as Address, abi: ERC20_VIEW_ABI, functionName: 'symbol' }),
    client.readContract({ address: baseToken as Address, abi: ERC20_VIEW_ABI, functionName: 'decimals' }),
  ]);

  // 3. Iterar getAssetInfo(0..numAssets-1) via Multicall3
  const assetInfoCalls = Array.from({ length: numAssets }, (_, i) => ({
    address: comet,
    abi: COMET_ABI,
    functionName: 'getAssetInfo' as const,
    args: [i] as const,
  }));
  const assetInfoResults = await client.multicall({ contracts: assetInfoCalls, allowFailure: true });

  // Extrair endereços e fazer batch de symbol/decimals
  type AssetInfoStruct = {
    offset: number;
    asset: Address;
    priceFeed: Address;
    scale: bigint;
    borrowCollateralFactor: bigint;
    liquidateCollateralFactor: bigint;
    liquidationFactor: bigint;
    supplyCap: bigint;
  };
  const assetInfos: { addr: Address; info: AssetInfoStruct }[] = [];
  for (let i = 0; i < assetInfoResults.length; i++) {
    const r = assetInfoResults[i]!;
    if (r.status !== 'success') continue;
    const info = r.result as AssetInfoStruct;
    assetInfos.push({ addr: info.asset, info });
  }

  // 4. Batch symbol + decimals dos collaterals
  const symbolCalls = assetInfos.map(({ addr }) => ({
    address: addr,
    abi: ERC20_VIEW_ABI,
    functionName: 'symbol' as const,
    args: [] as const,
  }));
  const decimalsCalls = assetInfos.map(({ addr }) => ({
    address: addr,
    abi: ERC20_VIEW_ABI,
    functionName: 'decimals' as const,
    args: [] as const,
  }));
  const [symbols, decimalsResults] = await Promise.all([
    client.multicall({ contracts: symbolCalls, allowFailure: true }),
    client.multicall({ contracts: decimalsCalls, allowFailure: true }),
  ]);

  // 5. Montar lista final
  const collaterals: CometCollateralInfo[] = [];
  const byCollateral = new Map<string, CometCollateralInfo>();

  for (let i = 0; i < assetInfos.length; i++) {
    const { addr, info } = assetInfos[i]!;
    const symRes = symbols[i]!;
    const decRes = decimalsResults[i]!;
    if (symRes.status !== 'success' || decRes.status !== 'success') continue;

    const collateral: CometCollateralInfo = {
      asset: getAddress(addr),
      symbol: symRes.result as string,
      decimals: Number(decRes.result),
      liquidationFactor: info.liquidationFactor,
      scale: info.scale,
    };
    collaterals.push(collateral);
    byCollateral.set(addr.toLowerCase(), collateral);
  }

  logger.info(
    {
      comet,
      cometName,
      baseToken: baseToken as Address,
      baseSymbol: baseSymbol as string,
      collaterals: collaterals.length,
    },
    `📋 ${cometName} (${baseSymbol}): ${collaterals.length} collaterals`,
  );

  return {
    comet,
    name: cometName,
    baseToken: baseToken as Address,
    baseTokenSymbol: baseSymbol as string,
    baseTokenDecimals: Number(baseDecimals),
    collaterals,
    byCollateral,
  };
}

/**
 * Build cache pra todos os Comets configurados na chain.
 * Atualmente: cUSDCv3 e cWETHv3 (definidos em chain-config.compoundV3).
 */
export async function buildCompoundCometCache(opts: {
  client: AnyPublicClient;
  chainId: number;
  comets: Array<{ comet: Address; name: string }>;
  logger?: LoggerLike;
}): Promise<CompoundCometCache> {
  const { client, chainId, comets, logger = NOOP_LOGGER } = opts;

  if (comets.length === 0) {
    logger.warn({ chainId }, 'Sem Comets configurados pra essa chain');
    return { chainId, comets: [] };
  }

  const infos = await Promise.all(
    comets.map(({ comet, name }) => buildCometInfo({ client, comet, cometName: name, logger })),
  );

  logger.info(
    { chainId, totalComets: infos.length },
    `✅ Compound Comet cache: ${infos.length} markets`,
  );

  return { chainId, comets: infos };
}
