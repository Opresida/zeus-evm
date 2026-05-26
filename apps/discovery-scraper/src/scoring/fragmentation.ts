/**
 * Fragmentação cross-DEX score.
 *
 * Mede ratio TVL_maiorDEX / TVL_menorDEX pra um par com pools em ≥2 DEXs.
 * Quanto maior o ratio, maior a "água azul" — pool menor demora a refletir
 * movimentos do pool maior = janela de arb mais frequente.
 *
 * Curva (0-100):
 *   ratio < 2x       → 0   (sem fragmentação real)
 *   ratio 2-5x       → 30
 *   ratio 5-10x      → 60
 *   ratio 10-50x     → 85
 *   ratio > 50x      → 100 (par estrela, ex: AERO/USDC = 350x)
 *
 * Peso no composite: 30% (a dimensão mais decisiva pro caso de uso).
 */

export interface FragmentationInput {
  /** TVL USD do DEX dominante */
  tvlDexA: number;
  /** TVL USD do DEX secundário */
  tvlDexB: number;
}

export function fragmentationScore(input: FragmentationInput): number {
  const { tvlDexA, tvlDexB } = input;

  if (tvlDexA <= 0 || tvlDexB <= 0) return 0;

  const larger = Math.max(tvlDexA, tvlDexB);
  const smaller = Math.min(tvlDexA, tvlDexB);
  const ratio = larger / smaller;

  if (ratio < 2) return 0;
  if (ratio < 5) return 30;
  if (ratio < 10) return 60;
  if (ratio < 50) return 85;
  return 100;
}

/**
 * Helper pra log/debug — retorna ratio cru pra display.
 */
export function calcRatio(tvlDexA: number, tvlDexB: number): number {
  if (tvlDexA <= 0 || tvlDexB <= 0) return 0;
  return Math.max(tvlDexA, tvlDexB) / Math.min(tvlDexA, tvlDexB);
}
