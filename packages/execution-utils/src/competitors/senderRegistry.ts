/**
 * SenderRegistry — Item 5 F1 do checklist.
 *
 * Storage em memória + persistência JSONL append-only. Mantém profile de cada
 * sender observado. Lookup O(1) por address.
 *
 * Persiste snapshot diário pra reconstruir state em restart sem perder histórico.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { Address } from 'viem';

import type {
  CompetitorProfile,
  CompetitorCategory,
  CompetitorRegistryStats,
} from './senderSchema';
import { lookupKnownAlias } from './senderSchema';

const ALL_CATEGORIES: CompetitorCategory[] = [
  'liquidator', 'mev_searcher', 'sandwich_bot', 'generic_arber',
  'whale_user', 'spammer', 'unknown',
];

export interface SenderRegistryOpts {
  /** Diretório de persistência. Default 'logs/competitors'. */
  baseDir?: string;
  /** Snapshot file name (default registry.json). */
  snapshotFile?: string;
  logger?: LoggerLike;
}

export interface UpdateInput {
  sender: Address;
  protocol: keyof CompetitorProfile['protocols'];
  priority_fee_gwei?: number;
  value_usd?: number;
  hour_utc: number;
  weekday: number;
  timestamp: number;
}

const DEFAULT_BASE_DIR = 'logs/competitors';
const DEFAULT_SNAPSHOT_FILE = 'registry.json';

/**
 * Registry com lookup O(1) + snapshot persistente.
 */
export class SenderRegistry {
  private readonly baseDir: string;
  private readonly snapshotPath: string;
  private readonly logger: LoggerLike | undefined;

  private readonly profiles = new Map<string, CompetitorProfile>();

  constructor(opts: SenderRegistryOpts = {}) {
    this.baseDir = opts.baseDir ?? DEFAULT_BASE_DIR;
    this.snapshotPath = join(this.baseDir, opts.snapshotFile ?? DEFAULT_SNAPSHOT_FILE);
    this.logger = opts.logger;
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
    this._loadSnapshot();
  }

  /**
   * Atualiza profile de um sender baseado em uma tx observada.
   * Cria profile novo se sender não existe ainda.
   */
  observe(input: UpdateInput): CompetitorProfile {
    const key = input.sender.toLowerCase();
    let profile = this.profiles.get(key);

    if (!profile) {
      profile = this._createProfile(input.sender, input.timestamp);
      this.profiles.set(key, profile);
    }

    profile.last_seen_at = input.timestamp;
    profile.total_txs++;

    // Atualiza protocol counts
    const proto = profile.protocols[input.protocol];
    if (proto) {
      proto.txs++;
      if (input.value_usd !== undefined) {
        proto.total_value_usd = (proto.total_value_usd ?? 0) + input.value_usd;
      }
    }

    // Gas fingerprint — running average + sample tracking
    if (input.priority_fee_gwei !== undefined && input.priority_fee_gwei > 0) {
      const g = profile.gas;
      g.samples++;
      // Running mean
      g.avg_priority_fee_gwei =
        g.avg_priority_fee_gwei + (input.priority_fee_gwei - g.avg_priority_fee_gwei) / g.samples;
      // Aproximação p95/p99 via running max (refinar com sliding window depois)
      if (input.priority_fee_gwei > g.p95_priority_fee_gwei) {
        g.p95_priority_fee_gwei = input.priority_fee_gwei;
      }
      if (input.priority_fee_gwei > g.p99_priority_fee_gwei) {
        g.p99_priority_fee_gwei = input.priority_fee_gwei;
      }
    }

    // Atividade temporal
    profile.activity.txs_last_24h++; // pruning periódico em refresh
    profile.activity.txs_last_7d++;
    profile.activity.txs_last_30d++;
    profile.activity.weekday_distribution[input.weekday] =
      (profile.activity.weekday_distribution[input.weekday] ?? 0) + 1;
    // Active hours: marca hour se >5% das txs
    const totalHours = profile.total_txs;
    if (!profile.activity.active_hours_utc.includes(input.hour_utc) && totalHours > 20) {
      profile.activity.active_hours_utc.push(input.hour_utc);
    }

    // Re-classifica periodicamente (a cada 50 txs novas)
    if (profile.total_txs % 50 === 0) {
      this._reclassify(profile);
    }

    return profile;
  }

  /**
   * Lookup direto. Retorna undefined se sender não está no registry.
   */
  get(sender: Address): CompetitorProfile | undefined {
    return this.profiles.get(sender.toLowerCase());
  }

  /**
   * Top N por threat_score.
   */
  topThreats(limit = 10): CompetitorProfile[] {
    return [...this.profiles.values()]
      .sort((a, b) => b.threat.overall_score - a.threat.overall_score)
      .slice(0, limit);
  }

  /**
   * Stats agregados.
   */
  stats(): CompetitorRegistryStats {
    const byCategory: Record<CompetitorCategory, number> = {} as Record<CompetitorCategory, number>;
    for (const c of ALL_CATEGORIES) byCategory[c] = 0;

    for (const p of this.profiles.values()) {
      byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    }

    const top10 = this.topThreats(10).map((p) => ({
      sender: p.sender,
      threat: p.threat.overall_score,
      alias: p.known_alias,
    }));

    return {
      total_profiles: this.profiles.size,
      by_category: byCategory,
      top_threats_top10: top10,
    };
  }

  /**
   * Persiste snapshot atual do registry.
   * Chamar periodicamente (e.g. a cada hora) ou em shutdown.
   */
  saveSnapshot(): void {
    try {
      const obj: Record<string, CompetitorProfile> = {};
      for (const [k, v] of this.profiles.entries()) obj[k] = v;
      writeFileSync(this.snapshotPath, JSON.stringify(obj, null, 2), 'utf-8');
      this.logger?.info(
        { path: this.snapshotPath, count: this.profiles.size },
        '💾 SenderRegistry snapshot salvo',
      );
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'SenderRegistry: erro salvando snapshot',
      );
    }
  }

  // ─── Internal ───

  private _loadSnapshot(): void {
    if (!existsSync(this.snapshotPath)) return;
    try {
      const raw = readFileSync(this.snapshotPath, 'utf-8');
      const obj = JSON.parse(raw);
      for (const k in obj) {
        this.profiles.set(k, obj[k] as CompetitorProfile);
      }
      this.logger?.info(
        { count: this.profiles.size },
        '📂 SenderRegistry: snapshot anterior carregado',
      );
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'SenderRegistry: erro carregando snapshot — começando vazio',
      );
    }
  }

  private _createProfile(sender: Address, timestamp: number): CompetitorProfile {
    return {
      sender,
      first_seen_at: timestamp,
      last_seen_at: timestamp,
      total_txs: 0,
      category: 'unknown',
      category_confidence: 0,
      tags: [],
      known_alias: lookupKnownAlias(sender),
      gas: {
        samples: 0,
        avg_priority_fee_gwei: 0,
        p50_priority_fee_gwei: 0,
        p95_priority_fee_gwei: 0,
        p99_priority_fee_gwei: 0,
      },
      activity: {
        txs_last_24h: 0,
        txs_last_7d: 0,
        txs_last_30d: 0,
        active_hours_utc: [],
        weekday_distribution: [0, 0, 0, 0, 0, 0, 0],
      },
      protocols: {
        aave_v3: { txs: 0 },
        compound_v3: { txs: 0 },
        morpho_blue: { txs: 0 },
        uniswap_v3: { txs: 0 },
        aerodrome: { txs: 0 },
      },
      threat: {
        overall_score: 0,
      },
    };
  }

  /**
   * Heurística simples de classificação baseado em pattern de tx.
   * Pra MVP: liquidator vs generic_arber vs unknown. Refinar com mais sinais.
   */
  private _reclassify(profile: CompetitorProfile): void {
    const liqTxs =
      profile.protocols.aave_v3.txs +
      profile.protocols.compound_v3.txs +
      profile.protocols.morpho_blue.txs;
    const dexTxs =
      profile.protocols.uniswap_v3.txs +
      profile.protocols.aerodrome.txs;
    const total = profile.total_txs;

    if (liqTxs / total > 0.7) {
      profile.category = 'liquidator';
      profile.category_confidence = Math.min(0.9, liqTxs / total);
      if (!profile.tags.includes('aave_liquidator') && profile.protocols.aave_v3.txs > 10) {
        profile.tags.push('aave_liquidator');
      }
    } else if (dexTxs / total > 0.7) {
      profile.category = 'generic_arber';
      profile.category_confidence = Math.min(0.85, dexTxs / total);
    } else if (profile.gas.p95_priority_fee_gwei > 5) {
      profile.category = 'mev_searcher';
      profile.category_confidence = 0.6;
      if (!profile.tags.includes('high_gas')) profile.tags.push('high_gas');
    }
    // else: 'unknown' (não muda)

    // Threat score simples: combina freq + gas + diversidade de protocolos
    const protocolDiversity = Object.values(profile.protocols).filter((p) => p.txs > 0).length;
    profile.threat.overall_score = Math.min(
      100,
      Math.floor(
        (profile.total_txs / 10) *
          (1 + profile.gas.avg_priority_fee_gwei / 10) *
          (1 + protocolDiversity / 5),
      ),
    );
  }
}
