/**
 * TxStateMachine — Item 9 R2 do checklist 16-items.
 *
 * State machine completa pra tx submetidas:
 *
 *   submitted → mempool → soft_confirmed (1 conf) → confirmed (2-3) → finalized (N)
 *                              ↓                                          ↑
 *                          orphaned ──────────────── (re-include) ────────┘
 *                              ↓
 *                            retry
 *
 * Substitui (ou complementa) o `positionDedup` adicionando reorg-awareness.
 *
 * **Por que importa:**
 *  - PnL só conta `finalized` (não soft_confirmed) — protege contra contar profit
 *    que reorg cancela
 *  - Em orphan, libera dedup pra re-submit
 *  - Cross-ref com FinalityTracker pra detectar quando nossa tx virou órfã
 *
 * Esta release entrega state machine standalone. Integração full com
 * positionDedup + orphan recovery + reorg listener fica em R3+R5 da próxima
 * iteração.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export type TxState =
  | 'submitted'        // raw tx enviada, ainda sem receipt
  | 'mempool'          // hash conhecido, em pending
  | 'soft_confirmed'   // 1 confirmação
  | 'confirmed'        // N confirmações (depende confirmationPolicy)
  | 'finalized'        // M confirmações (acima de N) ou L1 finality
  | 'orphaned'         // tx confirmou em bloco reorged
  | 'retried'          // tx orphaned → re-submetida com novo hash
  | 'failed';          // tx revertida on-chain (gas perdido)

export interface TxEntry {
  txHash: `0x${string}`;
  /** Chave lógica da operação (ex: 'aave-v3:0xborrower'). */
  operationKey: string;
  state: TxState;
  submittedAt: number;
  /** Bloco onde foi incluída (preenchido em soft_confirmed). */
  includedBlockNumber?: bigint;
  /** Hash do bloco onde foi incluída. */
  includedBlockHash?: `0x${string}`;
  /** N confirmações alcançadas. */
  confirmations: number;
  /** Tentativas de retry após orphan. */
  retryAttempts: number;
  /** Última transição de estado. */
  lastTransitionAt: number;
  /** Razão do estado final (failed/orphaned). */
  reason?: string;
}

export interface ConfirmationPolicy {
  /** N confs pra promover a 'confirmed'. Default 2 (Base ~3-4s). */
  confirmationsRequired: number;
  /** M confs pra promover a 'finalized'. Default 5 (Base ~10s). */
  finalizationRequired: number;
  /** Max retries em orphan recovery. Default 3. */
  maxRetryAttempts: number;
}

export interface TxStateMachineOpts {
  policy?: Partial<ConfirmationPolicy>;
  logger?: LoggerLike;
}

const DEFAULT_POLICY: ConfirmationPolicy = {
  confirmationsRequired: 2,
  finalizationRequired: 5,
  maxRetryAttempts: 3,
};

/**
 * State machine pra tracking de tx desde submit até finalization.
 *
 * Uso:
 *   const machine = new TxStateMachine({ logger });
 *   machine.recordSubmitted({ txHash, operationKey });
 *   machine.recordIncluded(txHash, blockNumber, blockHash);
 *   machine.recordConfirmations(txHash, latestBlock);
 *   machine.recordOrphan(txHash); // quando FinalityTracker detecta
 *
 *   const entry = machine.get(txHash);
 *   if (entry.state === 'finalized') {
 *     // contabiliza PnL aqui
 *   }
 */
export class TxStateMachine {
  private readonly policy: ConfirmationPolicy;
  private readonly logger: LoggerLike | undefined;
  private readonly entries = new Map<`0x${string}`, TxEntry>();
  /** Index secundário por operationKey pra dedup lookup. */
  private readonly byOperation = new Map<string, Set<`0x${string}`>>();

  constructor(opts: TxStateMachineOpts = {}) {
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.logger = opts.logger;
  }

  /**
   * Registra tx submetida. Estado inicial 'submitted'.
   */
  recordSubmitted(params: { txHash: `0x${string}`; operationKey: string }): TxEntry {
    const entry: TxEntry = {
      txHash: params.txHash,
      operationKey: params.operationKey,
      state: 'submitted',
      submittedAt: Date.now(),
      confirmations: 0,
      retryAttempts: 0,
      lastTransitionAt: Date.now(),
    };
    this.entries.set(params.txHash, entry);

    const set = this.byOperation.get(params.operationKey) ?? new Set();
    set.add(params.txHash);
    this.byOperation.set(params.operationKey, set);

    return entry;
  }

  /**
   * Transição submitted → mempool (tx hash visto pelo RPC).
   */
  recordInMempool(txHash: `0x${string}`): TxEntry | undefined {
    const entry = this.entries.get(txHash);
    if (!entry) return undefined;
    if (entry.state === 'submitted') {
      this._transition(entry, 'mempool');
    }
    return entry;
  }

  /**
   * Tx incluída num bloco. Transição → soft_confirmed (conf=1).
   */
  recordIncluded(
    txHash: `0x${string}`,
    blockNumber: bigint,
    blockHash: `0x${string}`,
  ): TxEntry | undefined {
    const entry = this.entries.get(txHash);
    if (!entry) return undefined;
    entry.includedBlockNumber = blockNumber;
    entry.includedBlockHash = blockHash;
    entry.confirmations = 1;
    this._transition(entry, 'soft_confirmed');
    return entry;
  }

  /**
   * Atualiza confirmations baseado em latestBlock atual.
   * Promove pra 'confirmed' ou 'finalized' conforme policy.
   */
  recordConfirmations(txHash: `0x${string}`, latestBlock: bigint): TxEntry | undefined {
    const entry = this.entries.get(txHash);
    if (!entry) return undefined;
    if (!entry.includedBlockNumber) return entry;
    if (entry.state === 'orphaned' || entry.state === 'failed' || entry.state === 'retried') {
      return entry;
    }

    const confs = Number(latestBlock - entry.includedBlockNumber) + 1;
    entry.confirmations = Math.max(entry.confirmations, confs);

    if (confs >= this.policy.finalizationRequired) {
      if (entry.state !== 'finalized') this._transition(entry, 'finalized');
    } else if (confs >= this.policy.confirmationsRequired) {
      if (entry.state !== 'confirmed' && entry.state !== 'finalized') {
        this._transition(entry, 'confirmed');
      }
    }

    return entry;
  }

  /**
   * Tx caiu em bloco órfão (detectado por FinalityTracker).
   * Transição → 'orphaned'. Caller pode chamar `recordRetry` pra registrar re-submit.
   */
  recordOrphan(txHash: `0x${string}`, reason?: string): TxEntry | undefined {
    const entry = this.entries.get(txHash);
    if (!entry) return undefined;
    entry.reason = reason;
    this._transition(entry, 'orphaned');
    return entry;
  }

  /**
   * Marca tentativa de retry pós-orphan. Limita por maxRetryAttempts.
   * Retorna true se retry permitido; false se atingiu limite.
   */
  recordRetry(orphanedTxHash: `0x${string}`, newTxHash: `0x${string}`): boolean {
    const original = this.entries.get(orphanedTxHash);
    if (!original) return false;
    if (original.retryAttempts >= this.policy.maxRetryAttempts) {
      this.logger?.warn(
        { operationKey: original.operationKey, attempts: original.retryAttempts },
        'TxStateMachine: max retry attempts atingido — desistindo',
      );
      return false;
    }

    original.retryAttempts++;
    this._transition(original, 'retried');

    // Cria novo entry pro retry mantendo operationKey
    this.recordSubmitted({
      txHash: newTxHash,
      operationKey: original.operationKey,
    });
    // Propaga contagem de retries
    const newEntry = this.entries.get(newTxHash)!;
    newEntry.retryAttempts = original.retryAttempts;

    return true;
  }

  /**
   * Tx reverteu on-chain.
   */
  recordFailed(txHash: `0x${string}`, reason: string): TxEntry | undefined {
    const entry = this.entries.get(txHash);
    if (!entry) return undefined;
    entry.reason = reason;
    this._transition(entry, 'failed');
    return entry;
  }

  /**
   * Lookup por txHash.
   */
  get(txHash: `0x${string}`): TxEntry | undefined {
    return this.entries.get(txHash);
  }

  /**
   * Verifica se há tx em estado ativo (mempool/soft_confirmed/confirmed) pra essa operação.
   * Útil pra dedup ANTES de submeter nova.
   */
  hasActiveTxForOperation(operationKey: string): boolean {
    const txs = this.byOperation.get(operationKey);
    if (!txs) return false;
    for (const hash of txs) {
      const entry = this.entries.get(hash);
      if (!entry) continue;
      if (
        entry.state === 'submitted' ||
        entry.state === 'mempool' ||
        entry.state === 'soft_confirmed' ||
        entry.state === 'confirmed'
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Lista entries por estado.
   */
  byState(state: TxState): TxEntry[] {
    const out: TxEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.state === state) out.push(e);
    }
    return out;
  }

  /**
   * Stats: count por state.
   */
  stats(): Record<TxState, number> {
    const counts: Record<TxState, number> = {
      submitted: 0,
      mempool: 0,
      soft_confirmed: 0,
      confirmed: 0,
      finalized: 0,
      orphaned: 0,
      retried: 0,
      failed: 0,
    };
    for (const e of this.entries.values()) {
      counts[e.state]++;
    }
    return counts;
  }

  /**
   * Limpeza: remove entries em estado final (finalized/failed/retried) mais
   * velhas que `maxAgeMs`. Não remove orphaned (precisa decisão manual).
   */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [hash, entry] of this.entries.entries()) {
      const isFinal = entry.state === 'finalized' || entry.state === 'failed' || entry.state === 'retried';
      if (isFinal && entry.lastTransitionAt < cutoff) {
        this.entries.delete(hash);
        const set = this.byOperation.get(entry.operationKey);
        if (set) {
          set.delete(hash);
          if (set.size === 0) this.byOperation.delete(entry.operationKey);
        }
        removed++;
      }
    }
    return removed;
  }

  // ─── Internal ───

  private _transition(entry: TxEntry, to: TxState): void {
    const from = entry.state;
    entry.state = to;
    entry.lastTransitionAt = Date.now();
    this.logger?.debug(
      {
        txHash: entry.txHash,
        operationKey: entry.operationKey,
        from,
        to,
        confs: entry.confirmations,
      },
      `TxStateMachine: ${entry.txHash.slice(0, 10)} ${from} → ${to}`,
    );
  }
}
