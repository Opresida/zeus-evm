/**
 * Pool age score.
 *
 * Pools novos têm risco de rug pull / liquidez sumir. Pools velhos demais
 * geralmente já foram explorados (todo searcher já mapeou). Sweet spot é
 * 14-90 dias (madurez suficiente sem ser blue-chip overcompetido).
 *
 * Curva (0-100):
 *   < 7 dias       → 0   (hard filter elimina antes — aqui é fallback)
 *   7-14 dias      → 40
 *   14-90 dias     → 100 (sweet spot)
 *   90-365 dias    → 80  (madurez OK)
 *   > 365 dias     → 60  (oportunidade conhecida há tempo — competição alta)
 *
 * Peso no composite: 10%.
 */

export interface PoolAgeInput {
  ageDays: number;
}

export function poolAgeScore(input: PoolAgeInput): number {
  const { ageDays } = input;

  if (ageDays < 7) return 0;
  if (ageDays < 14) return 40;
  if (ageDays < 90) return 100;
  if (ageDays < 365) return 80;
  return 60;
}

/**
 * Calcula idade em dias a partir de timestamp ISO ou null.
 */
export function calcAgeDays(poolCreatedAt: string | null): number {
  if (!poolCreatedAt) return 30; // fallback médio quando data não disponível
  const created = new Date(poolCreatedAt).getTime();
  if (Number.isNaN(created)) return 30;
  const diffMs = Date.now() - created;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}
