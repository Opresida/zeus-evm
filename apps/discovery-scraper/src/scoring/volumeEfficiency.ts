/**
 * Volume / TVL efficiency score.
 *
 * Mede o "giro" do pool — quanto de volume passa relativo ao TVL. Pool com TVL
 * alto mas zero volume é um cemitério (não tem whales = sem oportunidades).
 * Pool com TVL baixo mas volume gigante pode ser wash trading (suspeito).
 *
 * Sweet spot: 5-15% giro diário = healthy active trading.
 *
 * Curva (0-100):
 *   ratio < 1%       → 20  (pouco volume relativo ao TVL = poucos whales)
 *   ratio 1-5%       → 60
 *   ratio 5-15%      → 100 (sweet spot: trading saudável)
 *   ratio 15-50%     → 70  (alto turnover, ainda OK)
 *   ratio > 50%      → 30  (suspeito: wash trading ou liquidez muito rasa)
 *
 * Peso no composite: 20%.
 */

export interface VolumeEfficiencyInput {
  volumeUsd24h: number;
  tvlUsd: number;
}

export function volumeEfficiencyScore(input: VolumeEfficiencyInput): number {
  const { volumeUsd24h, tvlUsd } = input;

  if (tvlUsd <= 0 || volumeUsd24h <= 0) return 0;

  const ratio = volumeUsd24h / tvlUsd;

  if (ratio < 0.01) return 20;
  if (ratio < 0.05) return 60;
  if (ratio < 0.15) return 100;
  if (ratio < 0.50) return 70;
  return 30;
}
