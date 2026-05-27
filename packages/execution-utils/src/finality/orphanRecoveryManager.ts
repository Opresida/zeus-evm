/**
 * OrphanRecoveryManager — Item 9 R5 do checklist.
 *
 * Quando FinalityTracker detecta reorg + TxStateMachine marca uma tx como
 * 'orphaned', este manager decide se re-submete automaticamente.
 *
 * Critérios pra recovery:
 *  - retryAttempts < maxRetryAttempts (default 3, configurável)
 *  - Oportunidade ainda válida (callback `validateOpportunity` retorna true)
 *  - Não está em cooldown / auto-pause
 *
 * Fluxo:
 *  1. FinalityTracker emite ReorgEvent
 *  2. OrphanRecoveryManager checa quais tx hashes estavam em blocos órfãos
 *  3. Pra cada: marca como 'orphaned' no TxStateMachine
 *  4. Chama `validateOpportunity(originalContext)` async
 *  5. Se válido, chama `resubmit(originalContext)` (caller-defined)
 *  6. TxStateMachine.recordRetry registra novo txHash
 *
 * Caller-defined callbacks porque retry logic é específica do protocolo
 * (Aave precisa re-checar HF, backrun precisa re-validar dislocation, etc).
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { TxStateMachine, TxEntry } from './txStateMachine';
import type { ReorgEvent } from './finalityTracker';

/**
 * Context preservado pra cada tx submetida pra eventual recovery.
 * Caller provê via `registerSubmission(txHash, context)`.
 */
export interface OrphanContext {
  /** Identificação da oportunidade. */
  operationKey: string;
  /** Função pra revalidar a oportunidade. Retorna true se ainda vale recovery. */
  validateOpportunity: () => Promise<boolean>;
  /** Função que re-submete e retorna novo txHash. */
  resubmit: () => Promise<`0x${string}` | null>;
  /** Timestamp da submissão original. */
  submittedAt: number;
  /** Metadata opcional pra logging. */
  metadata?: Record<string, unknown>;
}

export interface OrphanRecoveryStats {
  total_orphans_detected: number;
  total_recoveries_attempted: number;
  total_recoveries_succeeded: number;
  total_recoveries_failed: number;
  total_recoveries_skipped: number; // oportunidade não vale mais
}

export interface OrphanRecoveryManagerOpts {
  txStateMachine: TxStateMachine;
  /** Default 2min — tempo máximo entre orphan detection e tentativa de recovery. */
  recoveryTimeoutMs?: number;
  logger?: LoggerLike;
}

const DEFAULT_RECOVERY_TIMEOUT_MS = 2 * 60 * 1000;

export class OrphanRecoveryManager {
  private readonly txStateMachine: TxStateMachine;
  private readonly recoveryTimeoutMs: number;
  private readonly logger: LoggerLike | undefined;

  /** Contexts armazenados por txHash pra eventual recovery. */
  private readonly contexts = new Map<string, OrphanContext>();

  private stats: OrphanRecoveryStats = {
    total_orphans_detected: 0,
    total_recoveries_attempted: 0,
    total_recoveries_succeeded: 0,
    total_recoveries_failed: 0,
    total_recoveries_skipped: 0,
  };

  constructor(opts: OrphanRecoveryManagerOpts) {
    this.txStateMachine = opts.txStateMachine;
    this.recoveryTimeoutMs = opts.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
    this.logger = opts.logger;
  }

  /**
   * Registra context pra eventual recovery quando submeter uma tx.
   * Caller chama isto logo após sendTransaction.
   */
  registerSubmission(txHash: `0x${string}`, context: OrphanContext): void {
    this.contexts.set(txHash, context);
  }

  /**
   * Handler do reorg event do FinalityTracker.
   * Identifica nossas tx em blocos órfãos + dispara recovery.
   */
  async onReorg(event: ReorgEvent): Promise<void> {
    const orphanedHashes = this._findOurTxsInOrphans(event);
    if (orphanedHashes.length === 0) return;

    this.logger?.warn(
      {
        depth: event.depth,
        orphanedTxs: orphanedHashes,
        commonAncestor: event.commonAncestorBlock.toString(),
      },
      `🔄 OrphanRecovery: ${orphanedHashes.length} tx(s) afetadas pelo reorg`,
    );

    for (const txHash of orphanedHashes) {
      this.stats.total_orphans_detected++;
      await this._attemptRecovery(txHash);
    }
  }

  /**
   * Limpa context (chamado pelo TxStateMachine quando tx vira finalized/failed).
   */
  releaseContext(txHash: `0x${string}`): void {
    this.contexts.delete(txHash);
  }

  /**
   * Stats pra observability.
   */
  getStats(): OrphanRecoveryStats {
    return { ...this.stats };
  }

  /**
   * Contexts ativos (debug).
   */
  activeContexts(): number {
    return this.contexts.size;
  }

  // ─── Internal ───

  private _findOurTxsInOrphans(event: ReorgEvent): `0x${string}`[] {
    const orphanedBlocks = new Set(event.orphanedBlocks.map((b) => b.number));
    const found: `0x${string}`[] = [];

    for (const [txHash, _ctx] of this.contexts.entries()) {
      const entry = this.txStateMachine.get(txHash as `0x${string}`);
      if (!entry) continue;
      if (!entry.includedBlockNumber) continue;
      if (orphanedBlocks.has(entry.includedBlockNumber)) {
        found.push(txHash as `0x${string}`);
      }
    }

    return found;
  }

  private async _attemptRecovery(orphanedHash: `0x${string}`): Promise<void> {
    const context = this.contexts.get(orphanedHash);
    if (!context) {
      this.logger?.debug({ orphanedHash }, 'OrphanRecovery: sem context registrado (skip)');
      return;
    }

    // Timeout: muito tempo depois do submit, melhor não reaver
    const age = Date.now() - context.submittedAt;
    if (age > this.recoveryTimeoutMs) {
      this.logger?.warn(
        { orphanedHash, ageMs: age },
        `OrphanRecovery: tx muito antiga (${age}ms > ${this.recoveryTimeoutMs}ms) — skip`,
      );
      this.txStateMachine.recordOrphan(orphanedHash, 'orphan but too old to recover');
      this.contexts.delete(orphanedHash);
      this.stats.total_recoveries_skipped++;
      return;
    }

    // 1. Marca como orphaned na state machine
    this.txStateMachine.recordOrphan(orphanedHash, 'detected by reorg');

    // 2. Valida se oportunidade ainda existe
    try {
      const stillValid = await context.validateOpportunity();
      if (!stillValid) {
        this.logger?.info(
          { orphanedHash, operationKey: context.operationKey },
          'OrphanRecovery: oportunidade não vale mais — skip',
        );
        this.contexts.delete(orphanedHash);
        this.stats.total_recoveries_skipped++;
        return;
      }
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err, orphanedHash },
        'OrphanRecovery: erro validando oportunidade — skip',
      );
      this.contexts.delete(orphanedHash);
      this.stats.total_recoveries_failed++;
      return;
    }

    // 3. Re-submete
    this.stats.total_recoveries_attempted++;
    try {
      const newTxHash = await context.resubmit();
      if (!newTxHash) {
        this.logger?.warn(
          { orphanedHash, operationKey: context.operationKey },
          'OrphanRecovery: resubmit retornou null',
        );
        this.stats.total_recoveries_failed++;
        this.contexts.delete(orphanedHash);
        return;
      }

      // 4. Registra retry na state machine
      const recordOk = this.txStateMachine.recordRetry(orphanedHash, newTxHash);
      if (!recordOk) {
        this.logger?.warn(
          { orphanedHash, newTxHash },
          'OrphanRecovery: maxRetryAttempts atingido — desistindo',
        );
        this.stats.total_recoveries_failed++;
      } else {
        // Transfere context pra novo hash (mantém ability de retry transitive)
        this.contexts.set(newTxHash, {
          ...context,
          submittedAt: Date.now(),
        });
        this.stats.total_recoveries_succeeded++;
        this.logger?.info(
          { orphanedHash, newTxHash, operationKey: context.operationKey },
          `🔄 OrphanRecovery: ${orphanedHash.slice(0, 10)} → ${newTxHash.slice(0, 10)} re-submetido`,
        );
      }

      this.contexts.delete(orphanedHash);
    } catch (err) {
      this.logger?.error(
        { err: err instanceof Error ? err.message : err, orphanedHash },
        'OrphanRecovery: erro re-submetendo',
      );
      this.stats.total_recoveries_failed++;
      this.contexts.delete(orphanedHash);
    }
  }
}
