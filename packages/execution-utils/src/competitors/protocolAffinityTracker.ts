/**
 * ProtocolAffinityTracker — Item 5 F5 do checklist.
 *
 * Per-sender deep-dive: qual protocolo cada competitor "dorme abraçado".
 * Vai além do count simples — calcula:
 *  - affinity_score por protocolo (0-1) baseado em share + consistência temporal
 *  - dominant_protocol + secondary
 *  - specialization (focused | diversified | switching)
 *
 * Por que importa:
 *  - "Bot X é 95% aave-only" → não vai competir com nossas comp/morpho ops
 *  - "Bot Y é diversified entre 4 protocolos" → ameaça multi-front
 *  - "Bot Z switching frequente" → indica oportunismo, possivelmente humano/semi-auto
 *
 * Stateless: consome `CompetitorProfile.protocols` + recent observations.
 */

import type { Address } from 'viem';
import type { CompetitorProfile } from './senderSchema';

export type ProtocolKey =
  | 'aave_v3'
  | 'compound_v3'
  | 'morpho_blue'
  | 'uniswap_v3'
  | 'aerodrome';

export type SpecializationLevel = 'focused' | 'diversified' | 'switching' | 'inactive';

export interface ProtocolAffinity {
  sender: Address;
  total_txs: number;
  /** Map protocol → affinity score 0-1 (share da atividade). */
  affinity_scores: Record<ProtocolKey, number>;
  /** Protocolo com maior share. */
  dominant_protocol: ProtocolKey | null;
  /** Segundo lugar (pra detectar diversificação). */
  secondary_protocol: ProtocolKey | null;
  dominant_share: number;          // % do dominante (0-1)
  /** Quantos protocolos com >5% de share. */
  active_protocols: number;
  /** Classificação do sender. */
  specialization: SpecializationLevel;
  /** Entropy de Shannon — quanto maior, mais diversificado. */
  entropy: number;
}

const PROTOCOL_KEYS: ProtocolKey[] = [
  'aave_v3', 'compound_v3', 'morpho_blue', 'uniswap_v3', 'aerodrome',
];

/**
 * Computa affinity scores a partir do profile de um sender.
 */
export function computeAffinity(profile: CompetitorProfile): ProtocolAffinity {
  const total = profile.total_txs;

  if (total === 0) {
    return {
      sender: profile.sender,
      total_txs: 0,
      affinity_scores: emptyScores(),
      dominant_protocol: null,
      secondary_protocol: null,
      dominant_share: 0,
      active_protocols: 0,
      specialization: 'inactive',
      entropy: 0,
    };
  }

  // ─── Affinity = share simples ───
  const scores = emptyScores();
  for (const k of PROTOCOL_KEYS) {
    scores[k] = (profile.protocols[k]?.txs ?? 0) / total;
  }

  // ─── Ordena pra dominant + secondary ───
  const sorted = [...PROTOCOL_KEYS].sort((a, b) => scores[b] - scores[a]);
  const dominant = scores[sorted[0]!]! > 0 ? sorted[0]! : null;
  const secondary = sorted[1] && scores[sorted[1]] > 0 ? sorted[1] : null;
  const dominantShare = dominant ? scores[dominant]! : 0;
  const activeProtocols = PROTOCOL_KEYS.filter((k) => scores[k] > 0.05).length;

  // ─── Entropy de Shannon ───
  let entropy = 0;
  for (const k of PROTOCOL_KEYS) {
    const p = scores[k];
    if (p > 0) entropy -= p * Math.log2(p);
  }

  // ─── Classifica specialization ───
  let specialization: SpecializationLevel;
  if (dominantShare >= 0.85) {
    specialization = 'focused';
  } else if (activeProtocols >= 3) {
    specialization = entropy > 1.5 ? 'switching' : 'diversified';
  } else {
    specialization = 'diversified';
  }

  return {
    sender: profile.sender,
    total_txs: total,
    affinity_scores: scores,
    dominant_protocol: dominant,
    secondary_protocol: secondary,
    dominant_share: dominantShare,
    active_protocols: activeProtocols,
    specialization,
    entropy: Math.round(entropy * 100) / 100,
  };
}

/**
 * Agrega: pra cada protocolo, lista top-N senders por affinity.
 * Útil pra "quais bots são especialistas em aave-v3?" → calibrar bribe contra eles.
 */
export function topSpecialistsPerProtocol(
  profiles: CompetitorProfile[],
  limit = 5,
  minTxs = 20,
): Record<ProtocolKey, Array<{ sender: Address; share: number; total_txs: number; alias?: string }>> {
  const out: Record<ProtocolKey, Array<{ sender: Address; share: number; total_txs: number; alias?: string }>> =
    {} as Record<ProtocolKey, Array<{ sender: Address; share: number; total_txs: number; alias?: string }>>;

  for (const proto of PROTOCOL_KEYS) {
    const ranked = profiles
      .filter((p) => p.total_txs >= minTxs)
      .map((p) => ({
        sender: p.sender,
        share: p.total_txs > 0 ? (p.protocols[proto]?.txs ?? 0) / p.total_txs : 0,
        total_txs: p.total_txs,
        alias: p.known_alias,
      }))
      .filter((r) => r.share >= 0.3) // pelo menos 30% no protocol pra ser "specialist"
      .sort((a, b) => b.share - a.share)
      .slice(0, limit);
    out[proto] = ranked;
  }

  return out;
}

function emptyScores(): Record<ProtocolKey, number> {
  return {
    aave_v3: 0,
    compound_v3: 0,
    morpho_blue: 0,
    uniswap_v3: 0,
    aerodrome: 0,
  };
}
