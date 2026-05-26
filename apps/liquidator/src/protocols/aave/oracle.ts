/**
 * Aave V3 PriceOracle integration + token math utilities.
 *
 * Aave PriceOracle retorna preço em "base currency unit" — 8 decimals USD (mesmo
 * formato Chainlink). Ex: ETH = `350000000000` representa $3500.00.
 *
 * Usado pra:
 *  - Converter `expectedProfitWei` → USD (B-1 fix)
 *  - Converter `debtAsset wei → collateralAsset wei` com preços reais (B-2 fix)
 *  - Converter `gasCostUSD → debtAsset wei` (B-3 fix)
 *
 * Cache: prices são by-block. Pruna >3 blocos atrás. Usamos `getAssetsPrices`
 * batched quando >1 asset precisa de quote no mesmo bloco.
 */

import type { Address, PublicClient } from 'viem';

type AnyPublicClient = PublicClient<any, any>;

export const AAVE_V3_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getAssetPrice',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'asset' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getAssetsPrices',
    stateMutability: 'view',
    inputs: [{ type: 'address[]', name: 'assets' }],
    outputs: [{ type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'BASE_CURRENCY_UNIT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Aave V3 padrão = 10^8 (base = USD com 8 decimais). */
export const AAVE_BASE_CURRENCY_UNIT = 10n ** 8n;

type BlockKey = string;
type AssetKey = string;

interface CachedPrices {
  [block: BlockKey]: Map<AssetKey, bigint>;
}

/**
 * Wrapper sobre Aave V3 PriceOracle com cache by-block.
 *
 * Uso típico:
 *   const oracle = new AavePriceOracle(client, chainConfig.aave.oracle);
 *   const prices = await oracle.getAssetsPrices([debtAsset, collateralAsset]);
 *   const debtPrice = prices.get(debtAsset.toLowerCase())!;
 */
export class AavePriceOracle {
  private cache: CachedPrices = {};
  private readonly maxBlocksToCache = 3;

  constructor(
    private readonly client: AnyPublicClient,
    private readonly oracleAddress: Address,
  ) {}

  /**
   * Lê preço de um asset (8-dec USD). Cacheado por (block, asset).
   * Se `blockNumber` omitido, usa block atual.
   */
  async getAssetPrice(asset: Address, blockNumber?: bigint): Promise<bigint> {
    const block = blockNumber ?? (await this.client.getBlockNumber());
    const blockKey = block.toString();
    const assetKey = asset.toLowerCase();

    let blockCache = this.cache[blockKey];
    if (!blockCache) {
      blockCache = new Map();
      this.cache[blockKey] = blockCache;
      this.pruneOldCache(block);
    }

    const cached = blockCache.get(assetKey);
    if (cached !== undefined) return cached;

    const price = (await this.client.readContract({
      address: this.oracleAddress,
      abi: AAVE_V3_ORACLE_ABI,
      functionName: 'getAssetPrice',
      args: [asset],
      blockNumber: block,
    })) as bigint;

    blockCache.set(assetKey, price);
    return price;
  }

  /**
   * Batched: pega preços de N assets numa única call. Cache-aware (só fetch missing).
   * Retorna Map de `asset.toLowerCase()` → price (8-dec USD).
   */
  async getAssetsPrices(assets: Address[], blockNumber?: bigint): Promise<Map<AssetKey, bigint>> {
    const block = blockNumber ?? (await this.client.getBlockNumber());
    const blockKey = block.toString();

    let blockCache = this.cache[blockKey];
    if (!blockCache) {
      blockCache = new Map();
      this.cache[blockKey] = blockCache;
      this.pruneOldCache(block);
    }

    const result = new Map<AssetKey, bigint>();
    const needFetch: Address[] = [];

    for (const asset of assets) {
      const key = asset.toLowerCase();
      const cached = blockCache.get(key);
      if (cached !== undefined) {
        result.set(key, cached);
      } else {
        needFetch.push(asset);
      }
    }

    if (needFetch.length > 0) {
      const prices = (await this.client.readContract({
        address: this.oracleAddress,
        abi: AAVE_V3_ORACLE_ABI,
        functionName: 'getAssetsPrices',
        args: [needFetch],
        blockNumber: block,
      })) as readonly bigint[];

      for (let i = 0; i < needFetch.length; i++) {
        const key = needFetch[i]!.toLowerCase();
        const price = prices[i]!;
        blockCache.set(key, price);
        result.set(key, price);
      }
    }

    return result;
  }

  private pruneOldCache(currentBlock: bigint): void {
    const cutoff = currentBlock - BigInt(this.maxBlocksToCache);
    for (const key of Object.keys(this.cache)) {
      if (BigInt(key) < cutoff) {
        delete this.cache[key];
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Token Math Utilities — converters baseados em oracle price
// ═══════════════════════════════════════════════════════════════════════

/**
 * Converte amount de `tokenA wei` → `tokenB wei` usando oracle prices (8-dec USD).
 *
 *   valueUsd = amountA × priceA / 10^decimalsA
 *   amountB  = valueUsd × 10^decimalsB / priceB
 *
 * Combinado sem perder precisão:
 *   amountB = amountA × priceA × 10^decimalsB / (priceB × 10^decimalsA)
 *
 * Usado em B-2 fix: conversão `debt → collateral` que antes usava só decimalDiff.
 */
export function convertWeiByPrice(
  amountA: bigint,
  priceA: bigint,
  decimalsA: number,
  priceB: bigint,
  decimalsB: number,
): bigint {
  if (priceB === 0n) return 0n;
  return (amountA * priceA * 10n ** BigInt(decimalsB)) / (priceB * 10n ** BigInt(decimalsA));
}

/**
 * Converte amount em USD (float) → token wei usando oracle price.
 *
 *   amountWei = (usdAmount × 10^8) × 10^decimals / priceOracle
 *
 * Usado em B-3 fix: gas cost USD → wei do debt asset.
 */
export function usdToWei(
  usdAmount: number,
  tokenPrice: bigint,
  tokenDecimals: number,
): bigint {
  if (tokenPrice === 0n || usdAmount <= 0) return 0n;
  const usd8 = BigInt(Math.floor(usdAmount * Number(AAVE_BASE_CURRENCY_UNIT)));
  return (usd8 * 10n ** BigInt(tokenDecimals)) / tokenPrice;
}

/**
 * Converte token wei → USD (float) usando oracle price.
 *
 *   usdValue = amountWei × price / (10^decimals × 10^8)
 *
 * Usado em B-1 fix: `expectedProfitUsd` real em vez de assumir stable-peg.
 */
export function weiToUsd(
  amountWei: bigint,
  tokenPrice: bigint,
  tokenDecimals: number,
): number {
  if (tokenPrice === 0n) return 0;
  const usd8 = (amountWei * tokenPrice) / 10n ** BigInt(tokenDecimals);
  return Number(usd8) / Number(AAVE_BASE_CURRENCY_UNIT);
}
