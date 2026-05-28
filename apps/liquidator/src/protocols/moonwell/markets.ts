/**
 * Moonwell — cache de mTokens (underlying + decimals + symbol).
 *
 * Enumera markets via Comptroller.getAllMarkets() (auto-suficiente, sem subgraph).
 * Pra cada mToken lê underlying + decimals/symbol do underlying ERC20.
 */

import type { Address, PublicClient } from 'viem';

import { ERC20_VIEW_ABI, NOOP_LOGGER, type LoggerLike } from '@zeus-evm/aave-discovery';
import { COMPTROLLER_ABI, MTOKEN_ABI } from './abi';

type AnyPublicClient = PublicClient<any, any>;

export interface MoonwellMarketInfo {
  mToken: Address;
  mTokenSymbol: string;
  underlying: Address;
  underlyingSymbol: string;
  underlyingDecimals: number;
}

export interface MoonwellMarketCache {
  comptroller: Address;
  /** closeFactor + liquidationIncentive (1e18) — lidos 1x no boot. */
  closeFactorMantissa: bigint;
  liquidationIncentiveMantissa: bigint;
  markets: MoonwellMarketInfo[];
  /** Lookup rápido mToken → info. */
  byMToken: Map<string, MoonwellMarketInfo>;
}

export async function buildMoonwellMarketCache(opts: {
  client: AnyPublicClient;
  comptroller: Address;
  logger?: LoggerLike;
}): Promise<MoonwellMarketCache> {
  const { client, comptroller, logger = NOOP_LOGGER } = opts;

  // getAllMarkets + closeFactor + liquidationIncentive
  const [marketsRes, closeFactorRes, incentiveRes] = await client.multicall({
    contracts: [
      { address: comptroller, abi: COMPTROLLER_ABI, functionName: 'getAllMarkets' as const },
      { address: comptroller, abi: COMPTROLLER_ABI, functionName: 'closeFactorMantissa' as const },
      { address: comptroller, abi: COMPTROLLER_ABI, functionName: 'liquidationIncentiveMantissa' as const },
    ],
    allowFailure: true,
  });

  if (marketsRes?.status !== 'success') {
    logger.error('Moonwell: getAllMarkets falhou');
    return {
      comptroller, closeFactorMantissa: 0n, liquidationIncentiveMantissa: 0n,
      markets: [], byMToken: new Map(),
    };
  }
  const mTokens = marketsRes.result as readonly Address[];
  const closeFactorMantissa = (closeFactorRes?.status === 'success' ? closeFactorRes.result : 5n * 10n ** 17n) as bigint;
  const liquidationIncentiveMantissa = (incentiveRes?.status === 'success' ? incentiveRes.result : 108n * 10n ** 16n) as bigint;

  // underlying + mToken symbol de cada market
  const metaCalls = mTokens.flatMap((m) => [
    { address: m, abi: MTOKEN_ABI, functionName: 'underlying' as const },
    { address: m, abi: MTOKEN_ABI, functionName: 'symbol' as const },
  ]);
  const metaResults = await client.multicall({ contracts: metaCalls, allowFailure: true, batchSize: 100 });

  // Coleta underlyings válidos pra ler decimals/symbol
  const underlyingByMToken = new Map<string, Address>();
  const mTokenSymbol = new Map<string, string>();
  for (let i = 0; i < mTokens.length; i++) {
    const u = metaResults[i * 2];
    const s = metaResults[i * 2 + 1];
    if (u?.status === 'success') underlyingByMToken.set(mTokens[i]!.toLowerCase(), u.result as Address);
    if (s?.status === 'success') mTokenSymbol.set(mTokens[i]!.toLowerCase(), String(s.result));
  }

  const underlyings = Array.from(new Set(Array.from(underlyingByMToken.values()).map((a) => a.toLowerCase()))) as Address[];
  const uCalls = underlyings.flatMap((t) => [
    { address: t, abi: ERC20_VIEW_ABI, functionName: 'decimals' as const },
    { address: t, abi: ERC20_VIEW_ABI, functionName: 'symbol' as const },
  ]);
  const uResults = await client.multicall({ contracts: uCalls, allowFailure: true, batchSize: 100 });
  const uDecimals = new Map<string, number>();
  const uSymbol = new Map<string, string>();
  for (let i = 0; i < underlyings.length; i++) {
    const d = uResults[i * 2];
    const s = uResults[i * 2 + 1];
    const key = underlyings[i]!.toLowerCase();
    if (d?.status === 'success') uDecimals.set(key, Number(d.result));
    if (s?.status === 'success') uSymbol.set(key, String(s.result));
  }

  const markets: MoonwellMarketInfo[] = [];
  const byMToken = new Map<string, MoonwellMarketInfo>();
  for (const m of mTokens) {
    const mKey = m.toLowerCase();
    const underlying = underlyingByMToken.get(mKey);
    if (!underlying) continue; // mToken nativo (mGLMR) — Base não tem, skip defensivo
    const uKey = underlying.toLowerCase();
    const info: MoonwellMarketInfo = {
      mToken: m,
      mTokenSymbol: mTokenSymbol.get(mKey) ?? '???',
      underlying,
      underlyingSymbol: uSymbol.get(uKey) ?? '???',
      underlyingDecimals: uDecimals.get(uKey) ?? 18,
    };
    markets.push(info);
    byMToken.set(mKey, info);
  }

  logger.info(
    { markets: markets.length, closeFactor: closeFactorMantissa.toString(), incentive: liquidationIncentiveMantissa.toString() },
    `📊 Moonwell market cache: ${markets.length} mTokens`,
  );
  return { comptroller, closeFactorMantissa, liquidationIncentiveMantissa, markets, byMToken };
}
