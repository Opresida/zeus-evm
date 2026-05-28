/**
 * Uniswap V3 — pricing local (sem RPC por quote).
 *
 * O preço SPOT (marginal) de um pool UniV3 vem do `sqrtPriceX96` (slot0):
 *   price(token1/token0) = (sqrtPriceX96 / 2^96)^2
 *
 * Ajustado por decimals (token0/token1 podem ter decimals diferentes):
 *   priceHuman = rawPrice × 10^(decimals0 - decimals1)
 *
 * Usado pelo MIS (detectar divergência entre pools) + validação do swap
 * pós-liquidation. Matemática sensível — testada contra valores conhecidos.
 *
 * NOTA: spot price ≠ execution price. Pra swap real com impacto, ainda usar
 * o QuoterV2 (quoter.ts). O spot é pra DETECÇÃO rápida de divergência (MIS).
 */

const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;

/**
 * Preço spot token1/token0 a partir do sqrtPriceX96, em ponto fixo escalado 1e18.
 *
 * rawPrice = sqrtPriceX96^2 / 2^192  (token1 por token0, em unidades brutas)
 * Ajuste decimals + escala 1e18 pra precisão sem float.
 *
 * @returns preço de 1 token0 em token1, escalado 1e18 (ex: 2000e18 = 1 token0 vale 2000 token1)
 */
export function uniV3SpotPrice1e18(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): bigint {
  if (sqrtPriceX96 === 0n) return 0n;

  // rawPrice (token1/token0) = sqrtPriceX96^2 / 2^192
  // Escala por 1e18 ANTES de dividir pra preservar precisão:
  //   priceScaled = sqrtPriceX96^2 × 1e18 / 2^192
  const numerator = sqrtPriceX96 * sqrtPriceX96 * (10n ** 18n);
  let price = numerator / Q192;

  // Ajuste de decimals: priceHuman = raw × 10^(decimals0 - decimals1)
  const diff = decimals0 - decimals1;
  if (diff > 0) {
    price = price * 10n ** BigInt(diff);
  } else if (diff < 0) {
    price = price / 10n ** BigInt(-diff);
  }
  return price;
}

/**
 * Preço inverso (token0/token1) — quanto vale 1 token1 em token0, escalado 1e18.
 */
export function uniV3SpotPriceInverse1e18(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): bigint {
  const direct = uniV3SpotPrice1e18(sqrtPriceX96, decimals0, decimals1);
  if (direct === 0n) return 0n;
  // inverso = 1e18 × 1e18 / direct (mantém escala 1e18)
  return (10n ** 18n * 10n ** 18n) / direct;
}

/**
 * Converte tick → sqrtPriceX96 (aproximação via 1.0001^(tick/2) × 2^96).
 * Útil quando só temos o tick (não o sqrtPriceX96). Usa float intermediário —
 * suficiente pra DETECÇÃO de divergência, não pra execução.
 */
export function tickToSqrtPriceX96(tick: number): bigint {
  const sqrtRatio = Math.pow(1.0001, tick / 2);
  return BigInt(Math.floor(sqrtRatio * Number(Q96)));
}
