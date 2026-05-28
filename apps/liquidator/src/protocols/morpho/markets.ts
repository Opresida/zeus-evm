/**
 * Morpho Blue — cache de markets (params + decimals + symbols + liquidez).
 *
 * Enumera markets via eventos CreateMarket (auto-suficiente, sem subgraph),
 * filtra por liquidez real (totalBorrowAssets > min) e lê decimals/symbols dos
 * tokens. Markets vazios (a maioria em Base) são descartados.
 *
 * marketId = keccak256(abi.encode(marketParams)) — computado off-chain.
 */

import { encodeAbiParameters, keccak256, type Address, type PublicClient } from 'viem';

import { ERC20_VIEW_ABI, NOOP_LOGGER, type LoggerLike } from '@zeus-evm/aave-discovery';
import { MORPHO_ABI, MORPHO_CREATE_MARKET_EVENT_ABI } from './abi';

type AnyPublicClient = PublicClient<any, any>;

const FREE_TIER_BLOCK_RANGE_LIMIT = 9_999;

export interface MorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface MorphoMarketInfo {
  id: `0x${string}`;
  params: MorphoMarketParams;
  loanTokenSymbol: string;
  loanTokenDecimals: number;
  collateralTokenSymbol: string;
  collateralTokenDecimals: number;
  /** totalBorrowAssets no momento do cache build (pra filtro de liquidez). */
  totalBorrowAssets: bigint;
}

export interface MorphoMarketCache {
  morpho: Address;
  markets: MorphoMarketInfo[];
}

/**
 * Computa o market id (keccak256 do abi.encode dos 5 params).
 */
export function computeMorphoMarketId(params: MorphoMarketParams): `0x${string}` {
  const encoded = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
    ],
    [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
  );
  return keccak256(encoded);
}

/**
 * Enumera market ids via eventos CreateMarket (chunked, free-tier safe).
 */
export async function fetchMorphoMarketIds(opts: {
  client: AnyPublicClient;
  morpho: Address;
  blockLookback?: number;
}): Promise<Array<{ id: `0x${string}`; params: MorphoMarketParams }>> {
  const { client, morpho, blockLookback = 2_000_000 } = opts;
  const currentBlock = await client.getBlockNumber();
  const startBlock = currentBlock > BigInt(blockLookback) ? currentBlock - BigInt(blockLookback) : 0n;
  const step = BigInt(FREE_TIER_BLOCK_RANGE_LIMIT);

  const found = new Map<string, MorphoMarketParams>();
  for (let from = startBlock; from <= currentBlock; from += step + 1n) {
    const to = from + step > currentBlock ? currentBlock : from + step;
    try {
      const logs = await client.getLogs({
        address: morpho,
        event: MORPHO_CREATE_MARKET_EVENT_ABI,
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const args = (log as { args?: { id?: `0x${string}`; marketParams?: MorphoMarketParams } }).args;
        if (args?.id && args.marketParams) {
          found.set(args.id, args.marketParams);
        }
      }
    } catch {
      // chunk falhou — mantém o que já temos
    }
  }
  return Array.from(found.entries()).map(([id, params]) => ({ id: id as `0x${string}`, params }));
}

/**
 * Build do cache: enumera markets, filtra por liquidez, lê decimals/symbols.
 *
 * `minBorrowAssetsWei` filtra markets sem dívida real (a maioria em Base).
 * Pra não derreter RPC: lê market() + token metadata só dos que passam.
 */
export async function buildMorphoMarketCache(opts: {
  client: AnyPublicClient;
  morpho: Address;
  blockLookback?: number;
  minMarkets?: number;
  logger?: LoggerLike;
}): Promise<MorphoMarketCache> {
  const { client, morpho, blockLookback, logger = NOOP_LOGGER } = opts;

  const ids = await fetchMorphoMarketIds({ client, morpho, blockLookback });
  if (ids.length === 0) {
    logger.info('📋 Morpho: 0 markets encontrados via CreateMarket events');
    return { morpho, markets: [] };
  }

  // Lê totalBorrowAssets de todos via multicall (filtro de liquidez)
  const marketCalls = ids.map(({ id }) => ({
    address: morpho,
    abi: MORPHO_ABI,
    functionName: 'market' as const,
    args: [id] as const,
  }));
  const marketResults = await client.multicall({ contracts: marketCalls, allowFailure: true, batchSize: 100 });

  // Markets com dívida real (totalBorrowAssets > 0)
  const liveIdx: number[] = [];
  const totalBorrowByIdx = new Map<number, bigint>();
  for (let i = 0; i < marketResults.length; i++) {
    const r = marketResults[i]!;
    if (r.status !== 'success') continue;
    const data = r.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
    const totalBorrowAssets = data[2];
    if (totalBorrowAssets > 0n) {
      liveIdx.push(i);
      totalBorrowByIdx.set(i, totalBorrowAssets);
    }
  }

  if (liveIdx.length === 0) {
    logger.info({ scanned: ids.length }, '📋 Morpho: 0 markets com dívida ativa');
    return { morpho, markets: [] };
  }

  // Coleta tokens únicos pra ler decimals/symbols (1 multicall)
  const tokenSet = new Set<string>();
  for (const i of liveIdx) {
    tokenSet.add(ids[i]!.params.loanToken.toLowerCase());
    tokenSet.add(ids[i]!.params.collateralToken.toLowerCase());
  }
  const tokens = Array.from(tokenSet) as Address[];
  const metaCalls = tokens.flatMap((t) => [
    { address: t, abi: ERC20_VIEW_ABI, functionName: 'decimals' as const },
    { address: t, abi: ERC20_VIEW_ABI, functionName: 'symbol' as const },
  ]);
  const metaResults = await client.multicall({ contracts: metaCalls, allowFailure: true, batchSize: 100 });

  const decimalsByToken = new Map<string, number>();
  const symbolByToken = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const dec = metaResults[i * 2];
    const sym = metaResults[i * 2 + 1];
    const key = tokens[i]!.toLowerCase();
    if (dec?.status === 'success') decimalsByToken.set(key, Number(dec.result));
    if (sym?.status === 'success') symbolByToken.set(key, String(sym.result));
  }

  const markets: MorphoMarketInfo[] = [];
  for (const i of liveIdx) {
    const { id, params } = ids[i]!;
    const loanKey = params.loanToken.toLowerCase();
    const collKey = params.collateralToken.toLowerCase();
    markets.push({
      id,
      params,
      loanTokenSymbol: symbolByToken.get(loanKey) ?? '???',
      loanTokenDecimals: decimalsByToken.get(loanKey) ?? 18,
      collateralTokenSymbol: symbolByToken.get(collKey) ?? '???',
      collateralTokenDecimals: decimalsByToken.get(collKey) ?? 18,
      totalBorrowAssets: totalBorrowByIdx.get(i) ?? 0n,
    });
  }

  // Ordena por liquidez desc (markets maiores primeiro)
  markets.sort((a, b) => (b.totalBorrowAssets > a.totalBorrowAssets ? 1 : -1));

  logger.info(
    { scanned: ids.length, live: markets.length },
    `📊 Morpho market cache: ${markets.length} markets com dívida ativa`,
  );
  return { morpho, markets };
}
