/**
 * MultiSignalClassifier — Item 5 F7 do checklist.
 *
 * Classifier multi-sinal que combina TODAS fontes de evidência pra atribuir
 * `CompetitorCategory` com confidence calibrada:
 *
 *  1. Protocol affinity (F5) — qual protocolo o sender prefere
 *  2. Gas fingerprint (F3) — p50/p95 priority fee comparado ao mercado
 *  3. Activity pattern (F4) — burst detection + horários
 *  4. Builder attribution (F6) — em quais builders cai
 *  5. Known alias (KNOWN_BOTS) — override hardcoded
 *
 * Cada sinal contribui pontos pra categorias candidatas. Wins a categoria com
 * maior soma + confidence proporcional ao gap pro segundo.
 *
 * Por que substitui o classifier inline do SenderRegistry:
 *  - Inline só usa protocol share (1 sinal)
 *  - Este aqui usa 5 sinais ponderados, gera confidence mais honesta
 *  - Stateless: caller passa profile + dados externos, recebe classificação
 *  - Pode rodar batch (re-classifica TODOS profiles ao final do dia)
 */

import type { CompetitorProfile, CompetitorCategory } from './senderSchema';
import { lookupKnownAlias } from './senderSchema';
import { computeAffinity, type ProtocolAffinity } from './protocolAffinityTracker';

/**
 * Sinais externos opcionais pra alimentar o classifier.
 * Tudo opcional — quanto mais sinais, melhor a classification.
 */
export interface ClassifierSignals {
  /** Affinity já computado (senão calcula no spot). */
  affinity?: ProtocolAffinity;
  /** Mercado: priority fee p50 atual em gwei (Base ~0.05gwei). */
  market_p50_gas_gwei?: number;
  /** Total de tx revertidas/total observado. */
  revert_rate?: number;
  /** Quantos blocos seguidos o sender apareceu (burst). */
  consecutive_block_count?: number;
  /** % das txs em high-MEV builders (Flashbots, Beaver, Titan). */
  mev_builder_share?: number;
}

export interface ClassificationResult {
  category: CompetitorCategory;
  confidence: number;          // 0-1
  /** Top 3 categorias candidatas com seus scores. */
  candidates: Array<{ category: CompetitorCategory; score: number }>;
  tags: string[];
  /** Quais sinais contribuíram (pra debug/explainability). */
  signals_used: string[];
}

/**
 * Classifica um sender combinando todos sinais.
 * Override por known_alias se houver — esses são determinísticos.
 */
export function classifyMultiSignal(
  profile: CompetitorProfile,
  signals: ClassifierSignals = {},
): ClassificationResult {
  // ─── Known alias override (alta confidence) ───
  const alias = profile.known_alias ?? lookupKnownAlias(profile.sender);
  if (alias) {
    return {
      category: 'mev_searcher',
      confidence: 0.99,
      candidates: [{ category: 'mev_searcher', score: 1 }],
      tags: [`known:${alias}`],
      signals_used: ['known_alias'],
    };
  }

  // ─── Scores accumulator ───
  const scores: Record<CompetitorCategory, number> = {
    liquidator: 0,
    mev_searcher: 0,
    sandwich_bot: 0,
    generic_arber: 0,
    whale_user: 0,
    spammer: 0,
    unknown: 0.1,            // baseline pra ser unknown se nada se destaca
  };
  const tags: string[] = [];
  const signalsUsed: string[] = [];

  // ─── 1. Protocol affinity ───
  const aff = signals.affinity ?? computeAffinity(profile);
  signalsUsed.push('protocol_affinity');

  const lendingTxs = (aff.affinity_scores.aave_v3 + aff.affinity_scores.compound_v3 + aff.affinity_scores.morpho_blue);
  const dexTxs = (aff.affinity_scores.uniswap_v3 + aff.affinity_scores.aerodrome);

  if (lendingTxs >= 0.7) {
    scores.liquidator += 3 * lendingTxs;
    if (aff.dominant_protocol === 'aave_v3' && aff.dominant_share > 0.5) tags.push('aave_specialist');
    if (aff.dominant_protocol === 'compound_v3' && aff.dominant_share > 0.5) tags.push('compound_specialist');
    if (aff.dominant_protocol === 'morpho_blue' && aff.dominant_share > 0.5) tags.push('morpho_specialist');
  }
  if (dexTxs >= 0.7) {
    scores.generic_arber += 2.5 * dexTxs;
  }
  if (aff.specialization === 'switching') {
    scores.mev_searcher += 1;
    tags.push('switching_strategy');
  }

  // ─── 2. Gas fingerprint ───
  if (profile.gas.samples >= 10) {
    signalsUsed.push('gas_fingerprint');
    const market = signals.market_p50_gas_gwei ?? 0.05;
    const ratio = profile.gas.p95_priority_fee_gwei / Math.max(0.01, market);

    if (ratio > 50) {
      // Paga MUITO acima do mercado — clássico MEV searcher
      scores.mev_searcher += 3;
      tags.push('high_gas_premium');
    } else if (ratio > 10) {
      scores.mev_searcher += 1.5;
      scores.liquidator += 0.5;
    }
  }

  // ─── 3. Activity pattern (burst detection) ───
  if (signals.consecutive_block_count !== undefined) {
    signalsUsed.push('burst_pattern');
    if (signals.consecutive_block_count >= 5) {
      scores.sandwich_bot += 1.5;  // bursts típicos de sandwich
      scores.spammer += 0.5;
      tags.push('burst_active');
    }
  }

  // ─── 4. Revert rate (spammer indicator) ───
  if (signals.revert_rate !== undefined) {
    signalsUsed.push('revert_rate');
    if (signals.revert_rate > 0.4) {
      scores.spammer += 3;
      tags.push('high_revert_rate');
    } else if (signals.revert_rate > 0.2) {
      scores.spammer += 1;
    }
  }

  // ─── 5. Builder attribution ───
  if (signals.mev_builder_share !== undefined) {
    signalsUsed.push('builder_attribution');
    if (signals.mev_builder_share > 0.5) {
      scores.mev_searcher += 2;
      scores.sandwich_bot += 1;
      tags.push('mev_builder_routed');
    }
  }

  // ─── 6. Whale heurística (poucas txs, alto valor) ───
  const sumProto = Object.values(profile.protocols).reduce((a, p) => a + p.txs, 0);
  if (profile.total_txs < 30 && sumProto > 0) {
    // Volume sem padrão de bot (poucas txs no total)
    scores.whale_user += 1;
  }

  // ─── Resolve winner ───
  const ranked = (Object.entries(scores) as Array<[CompetitorCategory, number]>)
    .sort((a, b) => b[1] - a[1]);
  const top = ranked[0]!;
  const runnerUp = ranked[1]!;

  // Confidence = gap / total. Mais gap → mais confiança.
  const totalPositive = ranked.reduce((acc, [, s]) => acc + Math.max(0, s), 0) || 1;
  const gapShare = (top[1] - runnerUp[1]) / totalPositive;
  const confidence = Math.max(0.1, Math.min(0.95, top[1] / totalPositive + gapShare * 0.3));

  return {
    category: top[0],
    confidence: Math.round(confidence * 100) / 100,
    candidates: ranked.slice(0, 3).map(([category, score]) => ({ category, score })),
    tags,
    signals_used: signalsUsed,
  };
}

/**
 * Aplica o resultado de classify diretamente em CompetitorProfile (mutates).
 * Útil pra batch reclassification ao final do dia.
 */
export function applyClassification(profile: CompetitorProfile, result: ClassificationResult): void {
  profile.category = result.category;
  profile.category_confidence = result.confidence;
  for (const tag of result.tags) {
    if (!profile.tags.includes(tag)) profile.tags.push(tag);
  }
}
