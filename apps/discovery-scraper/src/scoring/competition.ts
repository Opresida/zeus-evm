/**
 * Competition score — inverso à densidade de bots/searchers ativos.
 *
 * Substitui placeholder fixo 50 que estávamos usando até F4. Agora calculado
 * a partir de CompetitionStats real (on-chain getLogs).
 *
 * Curva (0-100):
 *   0 bots únicos     → 100 (água azul perfeita — Tier-1 NÃO está olhando)
 *   1-2 bots          → 70  (algum interesse, ainda OK)
 *   3-5 bots          → 40  (médio — várias searchers ativos)
 *   6-10 bots         → 20  (saturado)
 *   > 10 bots         → 5   (mar vermelho)
 *
 * Quando dados são partial (algum getLogs falhou), penalizar ligeiramente
 * (- 10 pts) pra refletir incerteza.
 *
 * Peso no composite: 10% (igual ao placeholder anterior, agora com data real).
 */

import type { CompetitionStats } from '../sources/onchainCompetition';

export function competitionScore(stats: CompetitionStats): number {
  const bots = stats.estimatedBots;

  let baseScore: number;
  if (bots === 0) baseScore = 100;
  else if (bots <= 2) baseScore = 70;
  else if (bots <= 5) baseScore = 40;
  else if (bots <= 10) baseScore = 20;
  else baseScore = 5;

  // Penalidade quando dados são incompletos
  if (stats.partial) baseScore = Math.max(0, baseScore - 10);

  // Quando NÃO houve swap nenhum (pool inativo no range), assume neutro (50)
  if (stats.totalSwaps === 0) baseScore = 50;

  return baseScore;
}

/**
 * Helper textual pra log do scraper — "0 bots / 25 traders" etc.
 */
export function competitionSummary(stats: CompetitionStats): string {
  if (stats.totalSwaps === 0) return 'pool inativo';
  return `${stats.estimatedBots} bots / ${stats.totalUniqueTraders} traders (${stats.totalSwaps} swaps)`;
}
