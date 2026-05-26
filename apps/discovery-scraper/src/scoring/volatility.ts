/**
 * Volatility score.
 *
 * Mede movimento de preço. Token muito estável (stable-stable) = sem edge.
 * Token muito volátil = caos memecoin, slippage imprevisível, gas wars.
 * Sweet spot = token com narrative real movendo 20-80 bps por bloco médio
 * (= 5-15% por dia).
 *
 * Heurística: usa priceChange1h + priceChange24h pra estimar volatilidade média.
 * Quando vier `realizedVolatility` de fonte específica futura (Coingecko realized vol),
 * substituímos esse cálculo grosseiro.
 *
 * Curva (0-100):
 *   |change_24h| < 1%        → 20  (stable-like, sem movimento)
 *   |change_24h| 1-5%        → 70
 *   |change_24h| 5-15%       → 100 (sweet spot: ativo com narrative)
 *   |change_24h| 15-30%      → 70
 *   |change_24h| > 30%       → 30  (caos memecoin, imprevisível)
 *
 * Peso no composite: 15%.
 */

export interface VolatilityInput {
  priceChangePct24h: number; // pode ser negativo
  priceChangePct1h?: number;
}

export function volatilityScore(input: VolatilityInput): number {
  const abs24h = Math.abs(input.priceChangePct24h ?? 0);

  if (abs24h < 1) return 20;
  if (abs24h < 5) return 70;
  if (abs24h < 15) return 100;
  if (abs24h < 30) return 70;
  return 30;
}
