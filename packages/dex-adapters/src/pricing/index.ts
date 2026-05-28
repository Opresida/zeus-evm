/**
 * Pricing local — preço spot sem RPC por quote.
 *
 * Fundação do Market Inefficiency Scanner (MIS) e validação do swap pós-liquidation.
 * Calcula preço marginal a partir do estado do pool (sqrtPriceX96 / reserves).
 */

export {
  uniV3SpotPrice1e18,
  uniV3SpotPriceInverse1e18,
  tickToSqrtPriceX96,
} from './uniV3Pricing';

export {
  aeroVolatileSpotPrice1e18,
  aeroStableSpotPrice1e18,
  aeroSpotPrice1e18,
} from './aerodromePricing';

export {
  UNIV3_POOL_ABI,
  AERO_POOL_ABI,
  getUniV3PoolAddress,
  getAeroPoolAddress,
  readUniV3PoolState,
  readAeroPoolState,
  uniV3StateToSpot,
  aeroStateToSpot,
  type UniV3PoolState,
  type AeroPoolState,
} from './poolStateReader';

const WAD = 10n ** 18n;
const BPS = 10_000n;

/**
 * Divergência entre dois preços spot (mesmo par, DEXs/pools diferentes), em bps.
 *
 * É o sinal-base do MIS: divergência > threshold = ineficiência candidata.
 * Retorna |priceA - priceB| / min(priceA, priceB) em bps.
 *
 * @returns bps de divergência (ex: 50 = 0.5%). 0 se algum preço inválido.
 */
export function priceDivergenceBps(priceA1e18: bigint, priceB1e18: bigint): number {
  if (priceA1e18 <= 0n || priceB1e18 <= 0n) return 0;
  const diff = priceA1e18 > priceB1e18 ? priceA1e18 - priceB1e18 : priceB1e18 - priceA1e18;
  const base = priceA1e18 < priceB1e18 ? priceA1e18 : priceB1e18;
  return Number((diff * BPS) / base);
}

/**
 * Direção do arb dado divergência: compra na pool mais barata, vende na mais cara.
 * @returns 'buyA_sellB' (A mais barato) | 'buyB_sellA' (B mais barato) | 'none'
 */
export function arbDirection(priceA1e18: bigint, priceB1e18: bigint): 'buyA_sellB' | 'buyB_sellA' | 'none' {
  if (priceA1e18 <= 0n || priceB1e18 <= 0n) return 'none';
  if (priceA1e18 === priceB1e18) return 'none';
  // preço = token1 por token0. Mais barato comprar token0 onde preço é MENOR.
  return priceA1e18 < priceB1e18 ? 'buyA_sellB' : 'buyB_sellA';
}

export { WAD as PRICING_WAD };
