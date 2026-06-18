/**
 * adaptiveThresholds — OIE Etapa C (loop de feedback / auto-ajuste).
 *
 * Recalcula thresholds de decisão a partir dos SINAIS DE OBSERVAÇÃO do ledger
 * (frequência/persistência/EV observado) — funciona no DRY_RUN, onde NÃO há win-rate
 * realizado. Puro/stateless + PISOS (floors) pra nunca ir a valores perigosos.
 *
 * Uso típico: um scheduler chama `computeAdaptiveThresholds` a cada N min; o app loga
 * o resultado (você VÊ o auto-ajuste) e, se opt-in, injeta nos gates.
 */

import type { TimeseriesStore } from '../intelligence/timeseriesStore';
import { queryTopOpportunityPairs } from '../intelligence/observation';
import { queryDimensionStats, OBSERVATION_VALUE_CATEGORIES } from './dimensionStatsQuery';
import { rankDimension } from './dimensionScorer';

export interface AdaptiveThresholdsDeps {
  store: TimeseriesStore;
  chain: string;
  /** Janela de observação. Default 7 dias. */
  windowMs?: number;
  /** Piso do MIN_OPPORTUNITY_EV_USD. Default 0.5. */
  minEvFloorUsd?: number;
  /** Piso do MIN_PROFIT_USD. Default 1. */
  minProfitFloorUsd?: number;
  /** Fração do EV observado pro MIN_EV. Default 0.35. */
  evFraction?: number;
  /** Fração do lucro observado pro MIN_PROFIT. Default 0.6. */
  profitFraction?: number;
}

export interface AdaptiveThresholds {
  MIN_OPPORTUNITY_EV_USD: number;
  MIN_PROFIT_USD: number;
  /** Protocolo de maior score (prioridade sugerida). */
  topProtocol: string | null;
  computedAt: number;
  sources: {
    avgObservedProfitUsd: number;
    pairsSeen: number;
    protocolRank: string[];
  };
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Computa thresholds adaptativos a partir das observações do ledger.
 * Determinístico dado o estado do store. Respeita os pisos.
 */
export async function computeAdaptiveThresholds(deps: AdaptiveThresholdsDeps): Promise<AdaptiveThresholds> {
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const minEvFloor = deps.minEvFloorUsd ?? 0.5;
  const minProfitFloor = deps.minProfitFloorUsd ?? 1;
  const evFraction = deps.evFraction ?? 0.35;
  const profitFraction = deps.profitFraction ?? 0.6;
  const opts = { windowMs, chain: deps.chain };

  // ── EV/lucro observado (média dos avg_profit_usd dos pares vistos) ──
  const pairs = await queryTopOpportunityPairs(deps.store, opts);
  const avgObservedProfit = pairs.length > 0
    ? pairs.reduce((s, p) => s + p.avg_profit_usd, 0) / pairs.length
    : 0;

  // ── Prioridade de protocolo (top do dimensionScorer) ──
  // valueCategories de observação → o score reflete o lucro OBSERVADO (DRY_RUN), não 0.
  const protocolStats = await queryDimensionStats(deps.store, 'protocol', {
    ...opts,
    valueCategories: OBSERVATION_VALUE_CATEGORIES,
  });
  const protocolRanked = rankDimension('protocol', protocolStats, { windowMs });

  return {
    MIN_OPPORTUNITY_EV_USD: round2(Math.max(minEvFloor, avgObservedProfit * evFraction)),
    MIN_PROFIT_USD: round2(Math.max(minProfitFloor, avgObservedProfit * profitFraction)),
    topProtocol: protocolRanked[0]?.key ?? null,
    computedAt: Date.now(),
    sources: {
      avgObservedProfitUsd: round2(avgObservedProfit),
      pairsSeen: pairs.length,
      protocolRank: protocolRanked.slice(0, 5).map((p) => p.key),
    },
  };
}
