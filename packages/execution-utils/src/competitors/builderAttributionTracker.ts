/**
 * BuilderAttributionTracker — Item 5 F6 do checklist.
 *
 * Cross-ref de `block.miner` / `block.proposer` com lista pública de builders
 * conhecidos pra identificar quem está produzindo os blocos onde nossas e dos
 * competidores' tx caem.
 *
 * Em Base mainnet, sequencer é Coinbase. Em mainnet PoS futuro (quando expandir):
 *  - Flashbots Builder
 *  - Beaver Build
 *  - Titan Builder
 *  - rsync Builder
 *
 * Tracking:
 *  - Quantos blocos cada builder produziu na janela
 *  - Quantas das nossas txs caíram em cada builder
 *  - Qual builder cada sender adversário prefere
 *
 * Útil pra:
 *  - Saber se devemos roteamento bundle específico
 *  - Detectar builders hostis (que rejeitam nossas txs ou favorecem competidores)
 */

import type { Address } from 'viem';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

/**
 * Lista pública de builders conhecidos. Atualizar via PR conforme identificamos.
 * Keys são addresses lowercase (block.miner ou fee recipient).
 */
export const KNOWN_BUILDERS: Record<string, string> = {
  // Base sequencer (todos blocos)
  '0x4200000000000000000000000000000000000011': 'Base Sequencer',
  // Ethereum mainnet builders (pra expansão futura)
  '0x1f9090aae28b8a3dceadf281b0f12828e676c326': 'rsync Builder',
  '0x690b9a9e9aa1c9db991c7721a92d351db4fac990': 'Flashbots Builder',
  '0x95222290dd7278aa3ddd389cc1e1d165cc4bafe5': 'Beaver Build',
  '0x4838b106fce9647bdf1e7877bf73ce8b0bad5f97': 'Titan Builder',
  '0x4675c7e5baafbffbca748158becba61ef3b0a263': 'Builder0x69',
  '0xa1deafbcc6cdc0a89aae28a02a05e0e6e09d8f50': 'bloXroute MEV-Builder',
};

export function lookupBuilder(address: Address): string | undefined {
  return KNOWN_BUILDERS[address.toLowerCase()];
}

export interface BuilderStats {
  builder_address: string;
  builder_alias?: string;
  total_blocks_seen: number;
  our_txs_included: number;
  competitor_txs_seen: number;
  /** % dos blocos seen onde nossas txs caíram. */
  our_inclusion_rate: number;
  /** Last seen timestamp. */
  last_seen_at: number;
}

export interface BuilderAttributionOpts {
  /** Nosso operator/account address pra distinguir 'our' vs 'competitor'. */
  ourAccount: Address;
  logger?: LoggerLike;
}

interface BuilderRecord {
  total_blocks_seen: number;
  our_txs_included: number;
  competitor_txs_seen: number;
  last_seen_at: number;
}

/**
 * Tracker de builder attribution.
 *
 * Uso típico (background do block scanner):
 *   const tracker = new BuilderAttributionTracker({ ourAccount: bot.address });
 *   for each block:
 *     tracker.observeBlock(block.miner, block.transactions);
 */
export class BuilderAttributionTracker {
  private readonly ourAccountLower: string;
  private readonly logger: LoggerLike | undefined;
  private readonly builders = new Map<string, BuilderRecord>();

  constructor(opts: BuilderAttributionOpts) {
    this.ourAccountLower = opts.ourAccount.toLowerCase();
    this.logger = opts.logger;
  }

  /**
   * Observa um bloco e atribui counters ao builder.
   * `transactionFromAddresses` é a lista de `from` das txs no bloco.
   */
  observeBlock(builderAddress: Address, transactionFromAddresses: readonly Address[]): void {
    const key = builderAddress.toLowerCase();
    let record = this.builders.get(key);
    if (!record) {
      record = {
        total_blocks_seen: 0,
        our_txs_included: 0,
        competitor_txs_seen: 0,
        last_seen_at: Date.now(),
      };
      this.builders.set(key, record);
    }

    record.total_blocks_seen++;
    record.last_seen_at = Date.now();

    for (const from of transactionFromAddresses) {
      const fromLower = from.toLowerCase();
      if (fromLower === this.ourAccountLower) {
        record.our_txs_included++;
      } else {
        record.competitor_txs_seen++;
      }
    }
  }

  /**
   * Stats por builder.
   */
  byBuilder(builder: Address): BuilderStats | null {
    const key = builder.toLowerCase();
    const r = this.builders.get(key);
    if (!r) return null;

    const totalSeen = r.our_txs_included + r.competitor_txs_seen;
    return {
      builder_address: key,
      builder_alias: lookupBuilder(builder),
      total_blocks_seen: r.total_blocks_seen,
      our_txs_included: r.our_txs_included,
      competitor_txs_seen: r.competitor_txs_seen,
      our_inclusion_rate: r.total_blocks_seen > 0 ? r.our_txs_included / r.total_blocks_seen : 0,
      last_seen_at: r.last_seen_at,
    };
  }

  /**
   * Top builders por nossa inclusion rate.
   */
  topByInclusion(limit = 5): BuilderStats[] {
    const all = [...this.builders.entries()].map(([key, r]) => ({
      builder_address: key,
      builder_alias: lookupBuilder(key as Address),
      total_blocks_seen: r.total_blocks_seen,
      our_txs_included: r.our_txs_included,
      competitor_txs_seen: r.competitor_txs_seen,
      our_inclusion_rate: r.total_blocks_seen > 0 ? r.our_txs_included / r.total_blocks_seen : 0,
      last_seen_at: r.last_seen_at,
    }));
    return all
      .filter((s) => s.our_txs_included > 0)
      .sort((a, b) => b.our_inclusion_rate - a.our_inclusion_rate)
      .slice(0, limit);
  }

  /**
   * Top builders por volume total de competidores.
   * Útil pra identificar builders preferidos por MEV searchers.
   */
  topByCompetitorVolume(limit = 5): BuilderStats[] {
    const all = [...this.builders.entries()].map(([key, r]) => ({
      builder_address: key,
      builder_alias: lookupBuilder(key as Address),
      total_blocks_seen: r.total_blocks_seen,
      our_txs_included: r.our_txs_included,
      competitor_txs_seen: r.competitor_txs_seen,
      our_inclusion_rate: r.total_blocks_seen > 0 ? r.our_txs_included / r.total_blocks_seen : 0,
      last_seen_at: r.last_seen_at,
    }));
    return all
      .sort((a, b) => b.competitor_txs_seen - a.competitor_txs_seen)
      .slice(0, limit);
  }

  /**
   * Snapshot pra persistência.
   */
  snapshot(): Record<string, BuilderRecord> {
    const out: Record<string, BuilderRecord> = {};
    for (const [k, v] of this.builders.entries()) {
      out[k] = { ...v };
    }
    return out;
  }

  size(): number {
    return this.builders.size;
  }
}
