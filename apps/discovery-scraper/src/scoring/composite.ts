/**
 * Composite scoring — combina as 5 dimensões em score final 0-100.
 *
 * Pesos atuais (chute calibrado inicial, refinar via observação real):
 *   - Fragmentação cross-DEX:  30%
 *   - Volume/TVL efficiency:   20%
 *   - TVL sweet zone:          15%
 *   - Volatilidade:            15%
 *   - Idade do pool:           10%
 *   - Densidade searchers:     10%  (placeholder fixo 50 até Sprint 2 F4)
 *
 * Calibração futura (após 4 semanas de dados reais):
 *   - Comparar score_previsto vs profit_observado_real
 *   - Ajustar pesos via Bayesian update ou regressão simples
 */

import { fragmentationScore, calcRatio } from './fragmentation';
import { volumeEfficiencyScore } from './volumeEfficiency';
import { tvlSweetZoneScore } from './tvlSweetZone';
import { volatilityScore } from './volatility';
import { poolAgeScore } from './poolAge';

export interface CompositeInput {
  tvlDexA: number;
  tvlDexB: number;
  totalTvlUsd: number;
  volumeUsd24h: number;
  priceChangePct24h: number;
  priceChangePct1h?: number;
  ageDays: number;
  /** Score de competição (0-100). Default 50 quando Sprint 2 ainda não ativo. */
  competitionScore?: number;
}

export interface CompositeBreakdown {
  fragmentation: number;
  volumeEfficiency: number;
  tvlSweetZone: number;
  volatility: number;
  poolAge: number;
  competition: number;
  fragmentationRatio: number;
  volumePctOfTvl: number;
}

export interface CompositeScore {
  total: number;
  breakdown: CompositeBreakdown;
}

const WEIGHTS = {
  fragmentation: 0.30,
  volumeEfficiency: 0.20,
  tvlSweetZone: 0.15,
  volatility: 0.15,
  poolAge: 0.10,
  competition: 0.10,
} as const;

export function compositeScore(input: CompositeInput): CompositeScore {
  const frag = fragmentationScore({ tvlDexA: input.tvlDexA, tvlDexB: input.tvlDexB });
  const vol = volumeEfficiencyScore({
    volumeUsd24h: input.volumeUsd24h,
    tvlUsd: input.totalTvlUsd,
  });
  const tvl = tvlSweetZoneScore({ totalTvlUsd: input.totalTvlUsd });
  const volatility = volatilityScore({
    priceChangePct24h: input.priceChangePct24h,
    priceChangePct1h: input.priceChangePct1h,
  });
  const age = poolAgeScore({ ageDays: input.ageDays });
  const compet = input.competitionScore ?? 50;

  const total =
    frag * WEIGHTS.fragmentation +
    vol * WEIGHTS.volumeEfficiency +
    tvl * WEIGHTS.tvlSweetZone +
    volatility * WEIGHTS.volatility +
    age * WEIGHTS.poolAge +
    compet * WEIGHTS.competition;

  const volumePctOfTvl = input.totalTvlUsd > 0 ? (input.volumeUsd24h / input.totalTvlUsd) * 100 : 0;

  return {
    total: Math.round(total * 10) / 10,
    breakdown: {
      fragmentation: frag,
      volumeEfficiency: vol,
      tvlSweetZone: tvl,
      volatility,
      poolAge: age,
      competition: compet,
      fragmentationRatio: calcRatio(input.tvlDexA, input.tvlDexB),
      volumePctOfTvl: Math.round(volumePctOfTvl * 100) / 100,
    },
  };
}

export { WEIGHTS };
