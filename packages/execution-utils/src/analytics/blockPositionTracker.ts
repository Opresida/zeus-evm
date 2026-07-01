/**
 * BlockPositionTracker — Item 4 A2 do checklist.
 *
 * Captura posição relativa da nossa tx no bloco:
 *  - tx_index absoluto (0 = primeiro)
 *  - total_txs no bloco
 *  - relative_position (0.0 = primeiro, 1.0 = último)
 *
 * Sinais derivados:
 *  - Se ourTxIndex > 0 em mempool race competitivo → perdemos gas race
 *  - Se relative_position > 0.9 → estamos no fim do bloco (último a incluir)
 *
 * Usado pelo failureCollector + competitorResolver.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { PublicClient } from 'viem';

type AnyPublicClient = PublicClient<any, any>;

export interface BlockPositionInfo {
  our_tx_hash: string;
  block_number: bigint;
  our_tx_index: number;
  block_total_txs: number;
  /** 0.0 (primeiro) → 1.0 (último). */
  relative_position: number;
  /** True se nossa tx está no top 10% do bloco. */
  is_top_10pct: boolean;
  /** True se nossa tx está no bottom 10% do bloco. */
  is_bottom_10pct: boolean;
}

export interface BlockPositionTrackerOpts {
  client: AnyPublicClient;
  logger?: LoggerLike;
}

/**
 * Calcula posição da nossa tx no bloco.
 * Não persiste state — chamadas são stateless.
 */
export class BlockPositionTracker {
  private readonly client: AnyPublicClient;
  private readonly logger: LoggerLike | undefined;
  // Janela rolante das últimas posições resolvidas → responde "estamos sistematicamente no fundo?".
  private readonly window: { relative: number; bottom: boolean; top: boolean }[] = [];
  private readonly maxSamples = 200;

  constructor(opts: BlockPositionTrackerOpts) {
    this.client = opts.client;
    this.logger = opts.logger;
  }

  /** Agregado da janela (pro heartbeat/painel). samples=0 até a 1ª tx nossa ser resolvida. */
  summary(): { samples: number; bottom10pctPct: number; top10pctPct: number; avgRelative: number } {
    const n = this.window.length;
    if (n === 0) return { samples: 0, bottom10pctPct: 0, top10pctPct: 0, avgRelative: 0 };
    const bottom = this.window.filter((w) => w.bottom).length;
    const top = this.window.filter((w) => w.top).length;
    const avg = this.window.reduce((s, w) => s + w.relative, 0) / n;
    return {
      samples: n,
      bottom10pctPct: Math.round((bottom / n) * 100),
      top10pctPct: Math.round((top / n) * 100),
      avgRelative: Math.round(avg * 100) / 100,
    };
  }

  /**
   * Resolve posição da tx no bloco. Faz 1 RPC call `getBlock` se necessário.
   */
  async resolve(txHash: `0x${string}`, blockNumber: bigint): Promise<BlockPositionInfo | null> {
    try {
      const block = await this.client.getBlock({
        blockNumber,
        includeTransactions: false, // só hashes — barato
      });
      if (!block.transactions) return null;

      const txs = block.transactions as readonly string[];
      const idx = txs.findIndex((h) => h.toLowerCase() === txHash.toLowerCase());
      if (idx < 0) {
        this.logger?.warn(
          { txHash, blockNumber: blockNumber.toString() },
          'BlockPositionTracker: tx não encontrada no bloco indicado',
        );
        return null;
      }

      const total = txs.length;
      const relative = total > 1 ? idx / (total - 1) : 0;

      // Acumula na janela rolante (pro summary do heartbeat).
      this.window.push({ relative, bottom: relative >= 0.9, top: relative <= 0.1 });
      if (this.window.length > this.maxSamples) this.window.shift();

      return {
        our_tx_hash: txHash,
        block_number: blockNumber,
        our_tx_index: idx,
        block_total_txs: total,
        relative_position: relative,
        is_top_10pct: relative <= 0.1,
        is_bottom_10pct: relative >= 0.9,
      };
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err, txHash },
        'BlockPositionTracker: erro resolvendo posição',
      );
      return null;
    }
  }
}
