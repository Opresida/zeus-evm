/**
 * Morpho PRE-liquidation — scan da Factory → cache de contratos PreLiquidation + config.
 *
 * 1. Scan dos eventos `CreatePreLiquidation` da Factory (chunked, free-tier-safe) → endereços.
 * 2. Pra cada contrato: multicall `preLiquidationParams()` + `marketParams()` → PreLiquidationContractInfo.
 *
 * Factory Base (Fase 0): 0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef.
 */

import type { Address, PublicClient } from 'viem';
import { NOOP_LOGGER, type LoggerLike } from '@zeus-evm/aave-discovery';
import { keccak256, encodeAbiParameters } from 'viem';
import { PRE_LIQUIDATION_ABI, CREATE_PRE_LIQUIDATION_EVENT_ABI } from './abi';
import type { PreLiquidationContractInfo } from './types';

type AnyPublicClient = PublicClient<any, any>;
const FREE_TIER_BLOCK_RANGE_LIMIT = 9_999;

const ERC20_VIEW_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

type PreParamsResult = {
  preLltv: bigint;
  preLCF1: bigint;
  preLCF2: bigint;
  preLIF1: bigint;
  preLIF2: bigint;
  preLiquidationOracle: Address;
};
type MarketParamsResult = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };

/** Computa o market id (= keccak256(abi.encode(marketParams))). */
function marketIdOf(loanToken: Address, collateralToken: Address, oracle: Address, irm: Address, lltv: bigint): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [loanToken, collateralToken, oracle, irm, lltv],
    ),
  );
}

/** Scan dos contratos PreLiquidation criados pela Factory (event `CreatePreLiquidation`). */
export async function fetchPreLiquidationContracts(opts: {
  client: AnyPublicClient;
  factory: Address;
  fromBlock?: bigint;
}): Promise<Address[]> {
  const { client, factory, fromBlock = 0n } = opts;
  const currentBlock = await client.getBlockNumber();
  const step = BigInt(FREE_TIER_BLOCK_RANGE_LIMIT);
  const found = new Set<string>();
  for (let from = fromBlock; from <= currentBlock; from += step + 1n) {
    const to = from + step > currentBlock ? currentBlock : from + step;
    try {
      const logs = await client.getLogs({ address: factory, event: CREATE_PRE_LIQUIDATION_EVENT_ABI, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const addr = (log as { args?: { preLiquidation?: Address } }).args?.preLiquidation;
        if (addr) found.add(addr.toLowerCase());
      }
    } catch {
      // chunk falhou — mantém o que já temos
    }
  }
  return Array.from(found) as Address[];
}

/** Lê config + market de cada contrato PreLiquidation (multicall) → cache. */
export async function buildPreLiquidationCache(opts: {
  client: AnyPublicClient;
  factory: Address;
  fromBlock?: bigint;
  /** Filtro opcional: só mercados com este colateral (allowlist de endereços, lower-case). */
  collateralAllowlist?: Set<string>;
  logger?: LoggerLike;
}): Promise<PreLiquidationContractInfo[]> {
  const { client, factory, fromBlock, collateralAllowlist, logger = NOOP_LOGGER } = opts;
  const addresses = await fetchPreLiquidationContracts({ client, factory, fromBlock });
  if (addresses.length === 0) return [];

  const calls = addresses.flatMap((a) => [
    { address: a, abi: PRE_LIQUIDATION_ABI, functionName: 'preLiquidationParams' as const },
    { address: a, abi: PRE_LIQUIDATION_ABI, functionName: 'marketParams' as const },
  ]);
  const res = await client.multicall({ contracts: calls, allowFailure: true, batchSize: 50 });

  // 1ª passada: junta os pares válidos e coleta os tokens únicos (decimals/symbol em 1 multicall).
  const valid: Array<{ addr: Address; cfg: PreParamsResult; m: MarketParamsResult }> = [];
  const tokens = new Set<string>();
  for (let i = 0; i < addresses.length; i++) {
    const pp = res[i * 2];
    const mp = res[i * 2 + 1];
    if (pp?.status !== 'success' || mp?.status !== 'success') continue;
    const cfg = pp.result as PreParamsResult;
    const m = mp.result as MarketParamsResult;
    if (collateralAllowlist && !collateralAllowlist.has(m.collateralToken.toLowerCase())) continue;
    valid.push({ addr: addresses[i]!, cfg, m });
    tokens.add(m.loanToken.toLowerCase());
    tokens.add(m.collateralToken.toLowerCase());
  }
  if (valid.length === 0) return [];

  const uniqueTokens = Array.from(tokens) as Address[];
  const metaCalls = uniqueTokens.flatMap((t) => [
    { address: t, abi: ERC20_VIEW_ABI, functionName: 'decimals' as const },
    { address: t, abi: ERC20_VIEW_ABI, functionName: 'symbol' as const },
  ]);
  const metaRes = await client.multicall({ contracts: metaCalls, allowFailure: true, batchSize: 100 });
  const decByToken = new Map<string, number>();
  const symByToken = new Map<string, string>();
  for (let i = 0; i < uniqueTokens.length; i++) {
    const dec = metaRes[i * 2];
    const sym = metaRes[i * 2 + 1];
    const key = uniqueTokens[i]!.toLowerCase();
    if (dec?.status === 'success') decByToken.set(key, Number(dec.result));
    if (sym?.status === 'success') symByToken.set(key, String(sym.result));
  }

  const out: PreLiquidationContractInfo[] = [];
  for (const { addr, cfg, m } of valid) {
    const loanKey = m.loanToken.toLowerCase();
    const collKey = m.collateralToken.toLowerCase();
    out.push({
      preLiquidation: addr,
      marketId: marketIdOf(m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv),
      loanToken: m.loanToken,
      loanTokenSymbol: symByToken.get(loanKey) ?? '???',
      loanTokenDecimals: decByToken.get(loanKey) ?? 18,
      collateralToken: m.collateralToken,
      collateralTokenSymbol: symByToken.get(collKey) ?? '???',
      collateralTokenDecimals: decByToken.get(collKey) ?? 18,
      marketOracle: m.oracle,
      irm: m.irm,
      preLiquidationOracle: cfg.preLiquidationOracle,
      config: {
        preLltv: cfg.preLltv,
        preLCF1: cfg.preLCF1,
        preLCF2: cfg.preLCF2,
        preLIF1: cfg.preLIF1,
        preLIF2: cfg.preLIF2,
        lltv: m.lltv,
      },
    });
  }
  logger.info({ contracts: addresses.length, cached: out.length }, `🧬 PreLiquidation cache: ${out.length}/${addresses.length} mercados`);
  return out;
}
