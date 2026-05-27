/**
 * FinalityTracker — Item 9 R1 do checklist 16-items.
 *
 * Detecta reorgs comparando parent hash de blocos sequenciais.
 * Mantém ring buffer dos últimos N blocos (hash + parentHash + miner + timestamp).
 *
 * Cenário Base mainnet:
 *  - Sequencer Coinbase = reorgs raros mas existem
 *  - Soft reorgs (1-2 blocos): em congestion
 *  - Sequencer downtime: pode causar reorg 5-10 blocos
 *  - L1 finality (Base → Ethereum): 15-20min soft, 7d hard challenge
 *
 * **Por que importa:**
 *  - PnL conta profit em bloco órfão → registro errado
 *  - Position dedup mantém "confirmed" quando na real voltou pro mempool
 *  - Backrun sealed em órfão = bundle perdido sem fallback
 *  - Caches stale após reorg
 *
 * Esta release entrega:
 *  - Ring buffer + reorg detection
 *  - Emit ReorgEvent quando detectado
 *  - Circuit breaker: pausa dispatches se >N reorgs em janela
 */

import type { PublicClient } from 'viem';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

type AnyPublicClient = PublicClient<any, any>;

export interface FinalityTrackerOpts {
  client: AnyPublicClient;
  /** Tamanho do ring buffer. Default 32 blocos (~64s em Base). */
  bufferSize?: number;
  /** Threshold pra circuit breaker: N reorgs em windowMs → pausa. */
  reorgsForCircuitBreaker?: number;
  /** Janela do circuit breaker em ms. Default 5min. */
  circuitBreakerWindowMs?: number;
  /** Polling interval em ms entre fetches de blocos. Default 2000 (2s, ~1 bloco Base). */
  pollIntervalMs?: number;
  logger?: LoggerLike;
}

export interface BlockSnapshot {
  number: bigint;
  hash: `0x${string}`;
  parentHash: `0x${string}`;
  timestamp: number;            // Unix ms (já convertido de timestamp seconds)
  miner: `0x${string}` | null;
}

export interface ReorgEvent {
  detectedAt: number;            // Unix ms quando detectamos
  /** Bloco mais profundo afetado (common ancestor + 1). */
  commonAncestorBlock: bigint;
  /** Profundidade do reorg (quantos blocos foram orphaned). */
  depth: number;
  /** Blocos órfãos (com hashes antigos). */
  orphanedBlocks: BlockSnapshot[];
  /** Novos blocos que substituem os órfãos. */
  newBlocks: BlockSnapshot[];
}

export type ReorgListener = (event: ReorgEvent) => void;

export interface FinalityStats {
  trackedBlocks: number;
  latestBlock: bigint | null;
  reorgsInWindow: number;
  circuitBreakerActive: boolean;
  reorgsLifetime: number;
  lastReorgAt: number | null;
}

const DEFAULT_BUFFER_SIZE = 32;
const DEFAULT_REORGS_FOR_BREAKER = 3;
const DEFAULT_BREAKER_WINDOW_MS = 5 * 60 * 1000; // 5min
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class FinalityTracker {
  private readonly client: AnyPublicClient;
  private readonly bufferSize: number;
  private readonly reorgsForBreaker: number;
  private readonly breakerWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly logger: LoggerLike | undefined;

  private ringBuffer: BlockSnapshot[] = [];
  private listeners: ReorgListener[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;

  /** Histórico de timestamps de reorg pra circuit breaker. */
  private reorgTimestamps: number[] = [];
  private reorgsLifetime = 0;
  private lastReorgAt: number | null = null;

  constructor(opts: FinalityTrackerOpts) {
    this.client = opts.client;
    this.bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.reorgsForBreaker = opts.reorgsForCircuitBreaker ?? DEFAULT_REORGS_FOR_BREAKER;
    this.breakerWindowMs = opts.circuitBreakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.logger = opts.logger;
  }

  /**
   * Inicia polling de blocos + reorg detection.
   * Idempotente — chamar várias vezes não causa problema.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Primeiro fetch sync pra popular buffer + depois loop async
    void this._pollOnce();

    this.pollTimer = setInterval(() => {
      void this._pollOnce();
    }, this.pollIntervalMs);
    this.pollTimer.unref();

    this.logger?.info(
      {
        bufferSize: this.bufferSize,
        pollIntervalMs: this.pollIntervalMs,
        breakerThreshold: `${this.reorgsForBreaker} reorgs / ${this.breakerWindowMs}ms`,
      },
      '🔗 FinalityTracker iniciado',
    );
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Subscribe pra reorg events. Listener é chamado sync no momento da detecção.
   * Retorna função de unsubscribe.
   */
  onReorg(listener: ReorgListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Status: circuit breaker ativo se >reorgsForBreaker em breakerWindowMs.
   * Usado pelos pipelines pra pausar dispatches em momentos de alta volatilidade.
   */
  isCircuitBreakerActive(): boolean {
    this._pruneOldReorgs();
    return this.reorgTimestamps.length >= this.reorgsForBreaker;
  }

  stats(): FinalityStats {
    this._pruneOldReorgs();
    return {
      trackedBlocks: this.ringBuffer.length,
      latestBlock: this.ringBuffer.length > 0 ? this.ringBuffer[this.ringBuffer.length - 1]!.number : null,
      reorgsInWindow: this.reorgTimestamps.length,
      circuitBreakerActive: this.isCircuitBreakerActive(),
      reorgsLifetime: this.reorgsLifetime,
      lastReorgAt: this.lastReorgAt,
    };
  }

  /**
   * Lookup: bloco no ring buffer por number.
   * Retorna undefined se não está no buffer (mais profundo que bufferSize).
   */
  getBlock(number: bigint): BlockSnapshot | undefined {
    return this.ringBuffer.find((b) => b.number === number);
  }

  // ─── Internal ───

  private async _pollOnce(): Promise<void> {
    if (!this.running) return;
    try {
      const block = await this.client.getBlock({ blockTag: 'latest' });
      const snapshot: BlockSnapshot = {
        number: block.number ?? 0n,
        hash: block.hash ?? ('0x' as `0x${string}`),
        parentHash: block.parentHash,
        timestamp: Number(block.timestamp) * 1000,
        miner: block.miner ?? null,
      };

      const lastInBuffer = this.ringBuffer[this.ringBuffer.length - 1];

      // Primeiro fetch (buffer vazio): só popula
      if (!lastInBuffer) {
        this.ringBuffer.push(snapshot);
        return;
      }

      // Mesmo bloco que último tracked: skip (poll mais rápido que produção de blocos)
      if (snapshot.number === lastInBuffer.number && snapshot.hash === lastInBuffer.hash) {
        return;
      }

      // Bloco novo na sequência esperada: append
      if (snapshot.number === lastInBuffer.number + 1n && snapshot.parentHash === lastInBuffer.hash) {
        this._appendBlock(snapshot);
        return;
      }

      // Mesmo number, hash DIFERENTE = reorg em um bloco
      if (snapshot.number === lastInBuffer.number && snapshot.hash !== lastInBuffer.hash) {
        this._handleReorg(lastInBuffer.number, [lastInBuffer], [snapshot]);
        return;
      }

      // Gap (bloco > esperado + 1) ou parentHash não bate = possível reorg + gap
      // Re-fetch sequência pra identificar common ancestor
      await this._handleGapOrDeepReorg(snapshot);
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'FinalityTracker: erro no poll (silencioso)',
      );
    }
  }

  private _appendBlock(snapshot: BlockSnapshot): void {
    this.ringBuffer.push(snapshot);
    // Mantém tamanho do ring buffer
    while (this.ringBuffer.length > this.bufferSize) {
      this.ringBuffer.shift();
    }
  }

  private async _handleGapOrDeepReorg(latestSnapshot: BlockSnapshot): Promise<void> {
    // Busca blocos do ring buffer pra encontrar common ancestor
    // Estratégia: walk back do latest até achar parent que está no buffer

    const trackedHashes = new Set(this.ringBuffer.map((b) => b.hash));
    let cursor: BlockSnapshot = latestSnapshot;
    const newBlocks: BlockSnapshot[] = [cursor];

    // Walk back até parent estar no buffer (common ancestor) OU max 20 blocos
    const MAX_WALK = 20;
    for (let i = 0; i < MAX_WALK; i++) {
      if (trackedHashes.has(cursor.parentHash)) {
        // Achou common ancestor
        const ancestorIdx = this.ringBuffer.findIndex((b) => b.hash === cursor.parentHash);
        const orphaned = this.ringBuffer.slice(ancestorIdx + 1);
        const commonAncestor = this.ringBuffer[ancestorIdx]!.number;
        if (orphaned.length > 0) {
          this._handleReorg(commonAncestor + 1n, orphaned, newBlocks.reverse());
        } else {
          // Sem orphans = só gap (perdemos polls). Append normalmente.
          for (const b of newBlocks.reverse()) this._appendBlock(b);
        }
        return;
      }

      // Fetch parent
      try {
        const parent = await this.client.getBlock({ blockHash: cursor.parentHash });
        cursor = {
          number: parent.number ?? 0n,
          hash: parent.hash ?? ('0x' as `0x${string}`),
          parentHash: parent.parentHash,
          timestamp: Number(parent.timestamp) * 1000,
          miner: parent.miner ?? null,
        };
        newBlocks.push(cursor);
      } catch {
        // Não conseguiu fetchar parent — desiste do walk-back, append latest e log
        this.logger?.warn(
          { latestHash: latestSnapshot.hash, depth: i },
          'FinalityTracker: walk-back falhou — possível reorg profundo, append direto',
        );
        this._appendBlock(latestSnapshot);
        return;
      }
    }

    // Não achou ancestor em MAX_WALK = reorg muito profundo (≥20 blocos)
    // Reseta buffer e marca como reorg crítico
    this.logger?.error(
      { latestNumber: latestSnapshot.number.toString(), maxWalk: MAX_WALK },
      'FinalityTracker: reorg PROFUNDO detectado (>= MAX_WALK) — buffer reset',
    );
    const orphaned = [...this.ringBuffer];
    this.ringBuffer = [latestSnapshot];
    this._notifyReorg({
      detectedAt: Date.now(),
      commonAncestorBlock: orphaned[0]?.number ?? latestSnapshot.number,
      depth: orphaned.length,
      orphanedBlocks: orphaned,
      newBlocks: [latestSnapshot],
    });
  }

  private _handleReorg(
    commonAncestorBlock: bigint,
    orphanedBlocks: BlockSnapshot[],
    newBlocks: BlockSnapshot[],
  ): void {
    // Remove blocos órfãos do buffer
    this.ringBuffer = this.ringBuffer.filter((b) => !orphanedBlocks.some((o) => o.hash === b.hash));
    // Adiciona novos
    for (const b of newBlocks) this._appendBlock(b);

    const event: ReorgEvent = {
      detectedAt: Date.now(),
      commonAncestorBlock,
      depth: orphanedBlocks.length,
      orphanedBlocks,
      newBlocks,
    };

    this._notifyReorg(event);
  }

  private _notifyReorg(event: ReorgEvent): void {
    this.reorgTimestamps.push(event.detectedAt);
    this.reorgsLifetime++;
    this.lastReorgAt = event.detectedAt;

    this.logger?.warn(
      {
        commonAncestor: event.commonAncestorBlock.toString(),
        depth: event.depth,
        orphanedNumbers: event.orphanedBlocks.map((b) => b.number.toString()),
        newNumbers: event.newBlocks.map((b) => b.number.toString()),
        circuitBreaker: this.isCircuitBreakerActive(),
      },
      `⚠️  REORG detectado depth=${event.depth} ancestor=${event.commonAncestorBlock}`,
    );

    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.logger?.warn(
          { err: err instanceof Error ? err.message : err },
          'FinalityTracker listener throw — drop silencioso',
        );
      }
    }
  }

  private _pruneOldReorgs(): void {
    const cutoff = Date.now() - this.breakerWindowMs;
    while (this.reorgTimestamps.length > 0 && (this.reorgTimestamps[0] ?? 0) < cutoff) {
      this.reorgTimestamps.shift();
    }
  }
}
