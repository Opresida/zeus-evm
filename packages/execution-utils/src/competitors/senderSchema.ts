/**
 * Sender Registry Schema — Item 5 do checklist 16-items.
 *
 * Profile rico por sender (bot competidor potencial). Construído passivamente
 * por blockHistoryScanner observando TODOS blocos Base mainnet — sem submeter
 * nada, sem custo.
 *
 * **Por que importa:** competir em F1 sem saber nome dos pilotos é insano.
 * Hoje vemos pending txs mas não sabemos NADA dos jogadores. Em 1 semana de
 * coleta passiva temos perfil dos 50-100 bots mais ativos.
 *
 * Schema ML-friendly:
 *  - Numericals (gas avg/p95, txsPerDay, threat scores)
 *  - Categoricals (category, dominantBuilder, strategy)
 *  - Time-series (activeHoursUtc, weekdayDistribution)
 *  - Graph features (cooccurrence — futuro)
 */

import type { Address } from 'viem';

/**
 * Categoria inferida do sender via heurísticas no classifier.
 */
export type CompetitorCategory =
  | 'liquidator'        // chama liquidationCall/absorb/liquidate frequentemente
  | 'mev_searcher'      // bundle relays + alto priorityFee
  | 'sandwich_bot'      // pattern frontrun + backrun
  | 'generic_arber'     // cross-DEX swaps grandes
  | 'whale_user'        // user grande sem padrão de bot
  | 'spammer'           // muitas txs revertidas
  | 'unknown';

/**
 * Profile completo de um sender observado.
 */
export interface CompetitorProfile {
  // ─── Identidade ───
  sender: Address;
  first_seen_at: number;       // Unix ms
  last_seen_at: number;
  total_txs: number;

  // ─── Classificação ───
  category: CompetitorCategory;
  category_confidence: number; // 0-1
  /** Tags semânticos atribuídos pelo classifier. */
  tags: string[];
  /** Alias conhecido (ex: "Wintermute"), populado por knownBotsRegistry. */
  known_alias?: string;

  // ─── Gas fingerprint (rolling 7d) ───
  gas: {
    samples: number;
    avg_priority_fee_gwei: number;
    p50_priority_fee_gwei: number;
    p95_priority_fee_gwei: number;
    p99_priority_fee_gwei: number;
  };

  // ─── Atividade temporal ───
  activity: {
    txs_last_24h: number;
    txs_last_7d: number;
    txs_last_30d: number;
    /** Hours UTC com >5% das txs do sender. */
    active_hours_utc: number[];
    /** Distribuição semanal (índice 0=segunda...6=domingo). */
    weekday_distribution: number[];
  };

  // ─── Cobertura por protocolo ───
  protocols: {
    aave_v3: { txs: number; total_value_usd?: number };
    compound_v3: { txs: number; total_value_usd?: number };
    morpho_blue: { txs: number; total_value_usd?: number };
    uniswap_v3: { txs: number; total_value_usd?: number };
    aerodrome: { txs: number; total_value_usd?: number };
  };

  // ─── Threat score (vs nós) ───
  threat: {
    overall_score: number;        // 0-100
    /** Nº bruto de corridas que ele nos ganhou (head-to-head) — alimentado por recordWinAgainstUs. */
    wins_against_us?: number;
    /** % de vezes que ele ganhou de nós (lost_race / total head-to-head). */
    win_rate_vs_us?: number;
    /** Gwei a mais que pagamos em média quando competimos. */
    avg_gas_premium_over_us?: number;
    last_win_against_us_at?: number;
  };
}

/**
 * Stats agregados do registry.
 */
export interface CompetitorRegistryStats {
  total_profiles: number;
  by_category: Record<CompetitorCategory, number>;
  /** Top N por threat_score. */
  top_threats_top10: Array<{ sender: Address; threat: number; alias?: string }>;
}

/**
 * Lista pública de bots conhecidos pra cross-ref.
 * Pode ser expandida via PR ou config externo.
 */
export const KNOWN_BOTS: Record<string, string> = {
  // Wintermute (não confirmado em Base — placeholder)
  '0x4f3a120e72c76c22ae802d129f599bfdbc31cb81': 'Wintermute',
  // Symbolic Capital
  '0xc23d63e0e1ca4f29232a4d2cb1f4dc7a9bb1f1c2': 'Symbolic',
  // Adicionar conforme identificarmos via padrões
};

export function lookupKnownAlias(sender: Address): string | undefined {
  return KNOWN_BOTS[sender.toLowerCase()];
}
