/**
 * Aerodrome/Velodrome — pricing local (sem RPC por quote).
 *
 * Dois tipos de pool:
 *   - Volatile (k = x·y): preço marginal = reserveOut / reserveIn
 *   - Stable   (k = x³y + xy³): curva achatada perto do peg, preço marginal
 *     via derivada. Pra LSDs/stables (cbETH/WETH, USDC/USDT).
 *
 * Reserves são lidas em wei do token. Normalizamos por decimals pra preço humano.
 *
 * Spot price (marginal, amount→0) pra DETECÇÃO de divergência no MIS.
 * Pra execução real com impacto, usar quoteAerodrome (router.ts, getAmountOut on-chain).
 */

const WAD = 10n ** 18n;

/**
 * Normaliza reserve pra 18 decimals (facilita comparação entre tokens).
 */
function to18(reserve: bigint, decimals: number): bigint {
  if (decimals === 18) return reserve;
  if (decimals < 18) return reserve * 10n ** BigInt(18 - decimals);
  return reserve / 10n ** BigInt(decimals - 18);
}

/**
 * Preço spot de pool VOLATILE (constant product x·y=k).
 * price(token1 por token0) = reserve1 / reserve0 (normalizado decimals), escala 1e18.
 */
export function aeroVolatileSpotPrice1e18(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
): bigint {
  const r0 = to18(reserve0, decimals0);
  const r1 = to18(reserve1, decimals1);
  if (r0 === 0n) return 0n;
  return (r1 * WAD) / r0;
}

/**
 * Preço spot de pool STABLE (k = x³y + xy³).
 *
 * Preço marginal dy/dx = (3x²y + y³) / (x³ + 3xy²) — derivada implícita de k.
 * Avaliado nas reserves atuais (normalizadas 18-dec). Escala 1e18.
 *
 * Perto do peg (x≈y) tende a 1; longe do peg a curva diverge do constant product.
 * É essa divergência de modelo AMM que cria o edge em LSDs/stables.
 */
export function aeroStableSpotPrice1e18(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
): bigint {
  const x = to18(reserve0, decimals0);
  const y = to18(reserve1, decimals1);
  if (x === 0n || y === 0n) return 0n;

  // dy/dx = (3x²y + y³) / (x³ + 3xy²)
  // Escala por WAD; usa divisão por WAD² intermediária pra não estourar.
  // Trabalhamos em termos de x,y já em 1e18. Pra manter escala 1e18 no resultado:
  //   price = WAD × (3x²y + y³) / (x³ + 3xy²)
  // Reduz a magnitude dividindo numerador e denominador por um fator comum (WAD²).
  const num = (3n * x * x / WAD * y / WAD) + (y * y / WAD * y / WAD);
  const den = (x * x / WAD * x / WAD) + (3n * x * y / WAD * y / WAD);
  if (den === 0n) return 0n;
  return (num * WAD) / den;
}

/**
 * Helper unificado: spot price respeitando o tipo de pool.
 */
export function aeroSpotPrice1e18(
  stable: boolean,
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
): bigint {
  return stable
    ? aeroStableSpotPrice1e18(reserve0, reserve1, decimals0, decimals1)
    : aeroVolatileSpotPrice1e18(reserve0, reserve1, decimals0, decimals1);
}
