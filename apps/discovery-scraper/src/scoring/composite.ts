/**
 * Composite scoring — combina dimensões em score final 0-100.
 *
 * Pesos atuais (revisados F2.11):
 *   - Fragmentação cross-DEX:  25%  (era 30% — pode ser artefato em alguns casos)
 *   - Volume/TVL efficiency:   25%  (era 20% — sinal mais confiável de whale activity)
 *   - TVL sweet zone:          20%  (era 15% — importante pra slippage no flashloan)
 *   - Volatilidade:            10%  (era 15% — memecoin volátil pode ser caro)
 *   - Idade do pool:           10%  (igual — maturity baseline)
 *   - Densidade searchers:     10%  (placeholder fixo 50 até F4)
 *
 * Soft adjustments (aplicados sobre o score final, depois dos pesos):
 *   - Penalty: top holder concentration 10-30%   → -10 pts
 *   - Penalty: holder count 100-500              → -10 pts
 *   - Penalty: buy/sell tax (cada 1%)            → -5 pts cada %
 *   - Boost: listado em CEX Tier-1               → +10 pts
 *
 * Calibração futura (após 4 semanas de dados reais): comparar score previsto
 * vs profit observado, ajustar pesos via regressão simples.
 */

import { fragmentationScore, calcRatio } from './fragmentation';
import { volumeEfficiencyScore } from './volumeEfficiency';
import { tvlSweetZoneScore } from './tvlSweetZone';
import { volatilityScore } from './volatility';
import { poolAgeScore } from './poolAge';
import type { TokenSafety } from '@zeus-evm/execution-utils';

export interface CompositeInput {
  tvlDexA: number;
  tvlDexB: number;
  totalTvlUsd: number;
  volumeUsd24h: number;
  priceChangePct24h: number;
  priceChangePct1h?: number;
  ageDays: number;
  /** Score de competição (0-100). Default 50 quando Sprint 2 (F4) ainda não ativo. */
  competitionScore?: number;
  /** Token safety dos 2 tokens do par (opcional). Quando presente, ativa soft adjustments. */
  baseTokenSafety?: TokenSafety;
  quoteTokenSafety?: TokenSafety;
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
  /** Adjustments aplicados pelo soft scoring (positivos = boost, negativos = penalty). */
  softAdjustments: number;
  /** Detalhes do soft scoring pra debug. */
  softAdjustmentsDetails: string[];
}

export interface CompositeScore {
  total: number;
  breakdown: CompositeBreakdown;
}

const WEIGHTS = {
  fragmentation: 0.25,
  volumeEfficiency: 0.25,
  tvlSweetZone: 0.20,
  volatility: 0.10,
  poolAge: 0.10,
  competition: 0.10,
} as const;

const SOFT_THRESHOLDS = {
  HOLDER_CONCENTRATION_MIN: 10,
  HOLDER_CONCENTRATION_MAX: 30,
  HOLDER_COUNT_LOW_MIN: 100,
  HOLDER_COUNT_LOW_MAX: 500,
  TAX_PENALTY_PER_PCT: -5,
  HOLDER_CONCENTRATION_PENALTY: -10,
  HOLDER_COUNT_LOW_PENALTY: -10,
  CEX_TIER1_BOOST: 10,
} as const;

/**
 * Calcula soft adjustments (penalties + boosts) baseados em TokenSafety.
 * Retorna soma dos ajustes + array de descrições pra log.
 */
function calcSoftAdjustments(
  baseToken?: TokenSafety,
  quoteToken?: TokenSafety,
): { delta: number; details: string[] } {
  if (!baseToken && !quoteToken) return { delta: 0, details: [] };

  let delta = 0;
  const details: string[] = [];

  for (const token of [baseToken, quoteToken]) {
    if (!token || token.partial) continue;
    const sym = token.address.slice(0, 8);

    // Penalty: holder concentration moderada (10-30%)
    if (
      token.topHolderPct >= SOFT_THRESHOLDS.HOLDER_CONCENTRATION_MIN &&
      token.topHolderPct < SOFT_THRESHOLDS.HOLDER_CONCENTRATION_MAX &&
      !token.topHolderIsLocked
    ) {
      delta += SOFT_THRESHOLDS.HOLDER_CONCENTRATION_PENALTY;
      details.push(`${sym}... top holder ${token.topHolderPct.toFixed(0)}% (${SOFT_THRESHOLDS.HOLDER_CONCENTRATION_PENALTY}pts)`);
    }

    // Penalty: holder count 100-500 (token jovem)
    if (
      token.holderCount >= SOFT_THRESHOLDS.HOLDER_COUNT_LOW_MIN &&
      token.holderCount < SOFT_THRESHOLDS.HOLDER_COUNT_LOW_MAX
    ) {
      delta += SOFT_THRESHOLDS.HOLDER_COUNT_LOW_PENALTY;
      details.push(`${sym}... só ${token.holderCount} holders (${SOFT_THRESHOLDS.HOLDER_COUNT_LOW_PENALTY}pts)`);
    }

    // Penalty: buy/sell tax (cada 1% custa 5 pontos)
    const totalTaxPct = token.buyTaxPct + token.sellTaxPct;
    if (totalTaxPct > 0) {
      const taxPenalty = Math.floor(totalTaxPct) * SOFT_THRESHOLDS.TAX_PENALTY_PER_PCT;
      delta += taxPenalty;
      details.push(`${sym}... tax buy+sell ${totalTaxPct.toFixed(1)}% (${taxPenalty}pts)`);
    }

    // Boost: listado em CEX Tier-1
    if (token.isListedOnCexTier1) {
      delta += SOFT_THRESHOLDS.CEX_TIER1_BOOST;
      details.push(`${sym}... CEX Tier-1 listing (+${SOFT_THRESHOLDS.CEX_TIER1_BOOST}pts)`);
    }
  }

  return { delta, details };
}

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

  const baseScore =
    frag * WEIGHTS.fragmentation +
    vol * WEIGHTS.volumeEfficiency +
    tvl * WEIGHTS.tvlSweetZone +
    volatility * WEIGHTS.volatility +
    age * WEIGHTS.poolAge +
    compet * WEIGHTS.competition;

  const { delta, details } = calcSoftAdjustments(input.baseTokenSafety, input.quoteTokenSafety);
  const total = Math.max(0, Math.min(100, baseScore + delta));

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
      softAdjustments: delta,
      softAdjustmentsDetails: details,
    },
  };
}

export { WEIGHTS, SOFT_THRESHOLDS };
