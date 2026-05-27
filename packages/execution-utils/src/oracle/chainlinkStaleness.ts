/**
 * ChainlinkStalenessChecker — Grupo B do bloqueio mainnet.
 *
 * Aave V3 / Compound III / Morpho / Moonwell — todos usam Chainlink AggregatorV3
 * como price feed. Se `latestRoundData().updatedAt` ficou > N segundos no passado,
 * o feed está STALE → o preço pode estar desatualizado → liquidation/arb baseado
 * nesse preço VAI dar errado (revert ou loss).
 *
 * Aave fornece `getSourceOfAsset(asset)` que retorna o aggregator usado por ele.
 * Compound III e Morpho também expõem feeds Chainlink direto na config.
 *
 * Multi-chain: Chainlink usa MESMA ABI Aggregator V3 em todas chains EVM
 * (Base, Arbitrum, Optimism, Polygon, Avalanche, Mainnet). Zero adaptação.
 *
 * Estratégia:
 *  - Cache: feed addresses por (chain, asset) — Aave nunca muda fonte mid-block
 *  - Cache: latestRoundData por (chain, feedAddress, block) — não re-fetch no mesmo bloco
 *  - Threshold configurável por feed (alguns updates a cada 1h, outros 24h)
 *  - Fail-safe: se RPC falhar, retornar `unknown` (caller decide skipar ou prosseguir)
 */

import type { Address, PublicClient } from 'viem';

type AnyPublicClient = PublicClient<any, any>;

export const CHAINLINK_AGGREGATOR_V3_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint80', name: 'roundId' },
      { type: 'int256', name: 'answer' },
      { type: 'uint256', name: 'startedAt' },
      { type: 'uint256', name: 'updatedAt' },
      { type: 'uint80', name: 'answeredInRound' },
    ],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;

export const AAVE_ORACLE_GET_SOURCE_ABI = [
  {
    type: 'function',
    name: 'getSourceOfAsset',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'asset' }],
    outputs: [{ type: 'address' }],
  },
] as const;

export interface StalenessCheckResult {
  status: 'fresh' | 'stale' | 'unknown' | 'invalid';
  /** Última atualização do feed em Unix seconds. */
  updated_at?: number;
  /** Idade do preço em segundos (now - updated_at). */
  age_seconds?: number;
  /** Threshold usado pra decisão. */
  threshold_seconds: number;
  /** Endereço do aggregator consultado. */
  feed_address?: Address;
  /** Razão pra status 'unknown' ou 'invalid'. */
  reason?: string;
}

export interface ChainlinkStalenessOpts {
  /** Default threshold se asset não tem override. Default 3600s (1h). */
  defaultThresholdSec?: number;
  /** Overrides por asset address lowercase. Ex: stable coins 24h, BTC/ETH 1h. */
  thresholdOverrides?: Record<string, number>;
}

const DEFAULT_THRESHOLD_SEC = 3600;

/**
 * Checker stateful — mantém cache de (feedAddress por asset) + (roundData por bloco).
 *
 * Uso típico no pipeline pre-dispatch:
 *
 *   const checker = new ChainlinkStalenessChecker(client, { defaultThresholdSec: 1800 });
 *   const result = await checker.checkAaveAssetStaleness(aaveOracleAddress, debtAsset);
 *   if (result.status === 'stale') return { ok: false, reason: 'oracle stale' };
 */
export class ChainlinkStalenessChecker {
  private readonly defaultThresholdSec: number;
  private readonly thresholdOverrides: Record<string, number>;
  private readonly feedAddressCache = new Map<string, Address>();
  private readonly roundDataCache = new Map<string, { block: bigint; updatedAt: number }>();

  constructor(
    private readonly client: AnyPublicClient,
    opts: ChainlinkStalenessOpts = {},
  ) {
    this.defaultThresholdSec = opts.defaultThresholdSec ?? DEFAULT_THRESHOLD_SEC;
    this.thresholdOverrides = opts.thresholdOverrides ?? {};
  }

  /**
   * Resolve feed Chainlink usado pelo Aave V3 PriceOracle pra um asset.
   * Cacheado — Aave não muda source mid-runtime.
   */
  async resolveAaveFeed(aaveOracleAddress: Address, asset: Address): Promise<Address> {
    const key = `${aaveOracleAddress.toLowerCase()}|${asset.toLowerCase()}`;
    const cached = this.feedAddressCache.get(key);
    if (cached) return cached;

    const source = (await this.client.readContract({
      address: aaveOracleAddress,
      abi: AAVE_ORACLE_GET_SOURCE_ABI,
      functionName: 'getSourceOfAsset',
      args: [asset],
    })) as Address;

    this.feedAddressCache.set(key, source);
    return source;
  }

  /**
   * Check direto contra um feed Chainlink (caller já tem o address).
   * Útil pra Compound III, Morpho — esses expõem feed direto na config.
   *
   * `thresholdOverride` força threshold específico ignorando overrides do feed.
   */
  async checkFeed(feedAddress: Address, thresholdOverride?: number): Promise<StalenessCheckResult> {
    const threshold = thresholdOverride
      ?? this.thresholdOverrides[feedAddress.toLowerCase()]
      ?? this.defaultThresholdSec;
    if (feedAddress === '0x0000000000000000000000000000000000000000') {
      return {
        status: 'invalid',
        threshold_seconds: threshold,
        reason: 'feed address zero (sem fonte configurada)',
      };
    }

    try {
      const result = (await this.client.readContract({
        address: feedAddress,
        abi: CHAINLINK_AGGREGATOR_V3_ABI,
        functionName: 'latestRoundData',
      })) as readonly [bigint, bigint, bigint, bigint, bigint];

      const updatedAt = Number(result[3]);
      const now = Math.floor(Date.now() / 1000);
      const ageSeconds = now - updatedAt;

      if (updatedAt === 0 || result[1] <= 0n) {
        return {
          status: 'invalid',
          threshold_seconds: threshold,
          updated_at: updatedAt,
          feed_address: feedAddress,
          reason: 'updatedAt=0 ou answer<=0',
        };
      }

      return {
        status: ageSeconds > threshold ? 'stale' : 'fresh',
        updated_at: updatedAt,
        age_seconds: ageSeconds,
        threshold_seconds: threshold,
        feed_address: feedAddress,
      };
    } catch (err) {
      return {
        status: 'unknown',
        threshold_seconds: threshold,
        feed_address: feedAddress,
        reason: err instanceof Error ? err.message : 'RPC error',
      };
    }
  }

  /**
   * One-shot: resolve feed do Aave + check staleness.
   */
  async checkAaveAssetStaleness(
    aaveOracleAddress: Address,
    asset: Address,
  ): Promise<StalenessCheckResult> {
    try {
      const feed = await this.resolveAaveFeed(aaveOracleAddress, asset);
      const threshold = this.thresholdOverrides[asset.toLowerCase()]
        ?? this.thresholdOverrides[feed.toLowerCase()]
        ?? this.defaultThresholdSec;
      return await this.checkFeed(feed, threshold);
    } catch (err) {
      return {
        status: 'unknown',
        threshold_seconds: this.defaultThresholdSec,
        reason: err instanceof Error ? err.message : 'failed to resolve feed',
      };
    }
  }

  /**
   * Batch: check N assets de uma vez (Aave V3).
   * Retorna Map asset.toLowerCase() → result.
   */
  async checkAaveAssetsStaleness(
    aaveOracleAddress: Address,
    assets: Address[],
  ): Promise<Map<string, StalenessCheckResult>> {
    const results = await Promise.all(
      assets.map((a) => this.checkAaveAssetStaleness(aaveOracleAddress, a).then((r) => [a.toLowerCase(), r] as const)),
    );
    return new Map(results);
  }

  /**
   * Helper de decisão: TODOS os assets passados estão fresh?
   * Trata 'unknown' como aceitável (fail-open) — caller pode tightening via opts se quiser.
   */
  static allFresh(results: Map<string, StalenessCheckResult>, opts: { strictUnknown?: boolean } = {}): boolean {
    for (const r of results.values()) {
      if (r.status === 'stale' || r.status === 'invalid') return false;
      if (opts.strictUnknown && r.status === 'unknown') return false;
    }
    return true;
  }
}
