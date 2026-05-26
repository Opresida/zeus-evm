/**
 * TVL Sweet Zone score (curva em sino).
 *
 * TVL muito baixo = pool ilíquido, slippage massiva pra flashloan.
 * TVL muito alto = blue-chip lotado de searchers Tier-1.
 * Sweet zone = pools com tamanho onde whales aparecem MAS competição é baixa.
 *
 * Pra nosso caso (flashloan ~$10k-50k), TVL ideal é onde:
 *   - Slippage < 0.5% pra trade de $10k
 *   - Volume diário comporta whales >$20k
 *   - Não atrai searchers Tier-1
 *
 * Curva (0-100) — função em sino:
 *   < $100k          → 10  (slippage massiva)
 *   $100k - $500k    → 60
 *   $500k - $20M     → 100 (sweet spot)
 *   $20M - $50M      → 70
 *   > $50M           → 30  (blue-chip lotado)
 *
 * Peso no composite: 15%.
 */

export interface TvlSweetZoneInput {
  /** TVL USD agregado (soma de todas as pools do par cross-DEX). */
  totalTvlUsd: number;
}

export function tvlSweetZoneScore(input: TvlSweetZoneInput): number {
  const { totalTvlUsd } = input;

  if (totalTvlUsd < 100_000) return 10;
  if (totalTvlUsd < 500_000) return 60;
  if (totalTvlUsd < 20_000_000) return 100;
  if (totalTvlUsd < 50_000_000) return 70;
  return 30;
}
