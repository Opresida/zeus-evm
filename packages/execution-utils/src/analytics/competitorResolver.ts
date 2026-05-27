/**
 * CompetitorResolver — Item 4 A3 do checklist.
 *
 * Post-mortem assíncrono: dado um failure (tx revertida ou skipada),
 * descobre quem GANHOU a oportunidade no mesmo bloco (ou blocos próximos).
 *
 * Estratégia:
 *  - Pra failures de liquidation: olha block do failure ± N blocos
 *  - Filtra txs que tocaram Aave Pool / Compound Comet / Morpho Blue
 *  - Identifica liquidação no mesmo borrower (collateral + debt match)
 *  - Cross-ref sender com SenderRegistry pra obter perfil
 *
 * Job assíncrono: não bloqueia hot path. Roda em batch periódico.
 */

import type { Address, PublicClient } from 'viem';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

import type { FailureEvent } from './failureSchema';
import type { SenderRegistry } from '../competitors/senderRegistry';

type AnyPublicClient = PublicClient<any, any>;

export interface CompetitorResolverOpts {
  client: AnyPublicClient;
  senderRegistry?: SenderRegistry;
  /** Aave V3 Pool, Compound Comets, Morpho Blue — endereços alvo. */
  targets: Address[];
  /** N blocos a olhar (default 3 blocos antes do nosso). */
  lookbackBlocks?: number;
  logger?: LoggerLike;
}

export interface ResolvedCompetitor {
  winner_tx_hash: string;
  winner_sender: Address;
  winner_alias?: string;
  winner_threat_score?: number;
  winner_block_number: bigint;
  winner_tx_index: number;
  winner_gas_used?: bigint;
  winner_priority_fee_wei?: bigint;
  /** ourBlock - winnerBlock. Negativo = competidor estava num bloco anterior (à frente). */
  block_delta: number;
  /** Diferença de tx index dentro do mesmo bloco. */
  index_delta?: number;
}

const DEFAULT_LOOKBACK = 3;

/**
 * Post-mortem assíncrono pra failures.
 * Recebe FailureEvent, retorna ResolvedCompetitor se encontrar.
 */
export class CompetitorResolver {
  private readonly client: AnyPublicClient;
  private readonly senderRegistry: SenderRegistry | undefined;
  private readonly targets: Set<string>;
  private readonly lookback: number;
  private readonly logger: LoggerLike | undefined;

  constructor(opts: CompetitorResolverOpts) {
    this.client = opts.client;
    this.senderRegistry = opts.senderRegistry;
    this.targets = new Set(opts.targets.map((a) => a.toLowerCase()));
    this.lookback = opts.lookbackBlocks ?? DEFAULT_LOOKBACK;
    this.logger = opts.logger;
  }

  /**
   * Tenta resolver competitor pro failure event.
   * Retorna null se não encontrar candidato plausível.
   *
   * Heurística (na ordem):
   *  1. Mesmo bloco, tx_index menor que nosso → frontrun direto
   *  2. Bloco N-1 ou N-2 → competidor entrou antes em bloco anterior
   *  3. Filtros: sender != nosso operator, to é target conhecido
   */
  async resolve(failure: FailureEvent, ourSender: Address): Promise<ResolvedCompetitor | null> {
    if (!failure.block_number) return null;

    const ourBlock = BigInt(failure.block_number);
    const startBlock = ourBlock - BigInt(this.lookback);

    try {
      // Walk back N blocks
      for (let b = ourBlock; b >= startBlock; b--) {
        const candidate = await this._scanBlock(b, ourSender, ourBlock, failure);
        if (candidate) return candidate;
      }
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err, failureId: failure.id },
        'CompetitorResolver: erro resolvendo (drop silencioso)',
      );
    }

    return null;
  }

  /**
   * Resolve em batch — útil pra job periódico.
   * Retorna array de (failure, competitor?) na mesma ordem.
   */
  async resolveBatch(
    failures: FailureEvent[],
    ourSender: Address,
  ): Promise<Array<{ failure: FailureEvent; competitor: ResolvedCompetitor | null }>> {
    const results: Array<{ failure: FailureEvent; competitor: ResolvedCompetitor | null }> = [];
    for (const f of failures) {
      const competitor = await this.resolve(f, ourSender);
      results.push({ failure: f, competitor });
    }
    return results;
  }

  // ─── Internal ───

  private async _scanBlock(
    blockNumber: bigint,
    ourSender: Address,
    ourBlock: bigint,
    failure: FailureEvent,
  ): Promise<ResolvedCompetitor | null> {
    const block = await this.client.getBlock({
      blockNumber,
      includeTransactions: true,
    });

    if (!block.transactions) return null;

    const ourSenderLower = ourSender.toLowerCase();

    for (let idx = 0; idx < block.transactions.length; idx++) {
      const tx = block.transactions[idx];
      if (typeof tx === 'string') continue;

      const from = tx.from?.toLowerCase();
      const to = tx.to?.toLowerCase();

      // Skip self + non-target txs
      if (from === ourSenderLower) continue;
      if (!to || !this.targets.has(to)) continue;

      // Found candidate — competidor mesmo target, sender diferente
      // Mais filtros poderiam ir aqui (decode calldata pra ver se é liquidationCall etc)
      // mas pra MVP basta o match básico

      const ourTxIdx = failure.our_tx_index ?? -1;
      const blockDelta = Number(ourBlock - blockNumber);
      const indexDelta = blockDelta === 0 && ourTxIdx >= 0 ? ourTxIdx - idx : undefined;

      // Lookup alias + threat via senderRegistry
      const profile = this.senderRegistry?.get(tx.from as Address);
      const alias = profile?.known_alias;
      const threat = profile?.threat?.overall_score;

      return {
        winner_tx_hash: tx.hash ?? '0x',
        winner_sender: tx.from as Address,
        winner_alias: alias,
        winner_threat_score: threat,
        winner_block_number: blockNumber,
        winner_tx_index: idx,
        winner_gas_used: tx.gas,
        winner_priority_fee_wei: tx.maxPriorityFeePerGas ?? tx.gasPrice,
        block_delta: blockDelta,
        index_delta: indexDelta,
      };
    }

    return null;
  }
}
