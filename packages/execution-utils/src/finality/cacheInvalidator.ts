/**
 * CacheInvalidator — Item 9 R3 do checklist.
 *
 * Hub central pra invalidação de caches em reorg detected.
 * Componentes registram callbacks via `register(name, flushFn)` no boot.
 * Quando FinalityTracker detecta reorg, chamamos todos callbacks em sequence.
 *
 * **Por que importa:** sem invalidação, caches ficam com data de bloco órfão:
 *  - slippageCache: quotes pré-reorg ainda válidos por TTL 60s
 *  - Aave PriceOracle cache: preços by-block do bloco órfão
 *  - cometCache: estado Comet pré-reorg
 *
 * Resultado: bot toma decisões baseado em estado errado pós-reorg.
 *
 * Esta implementação é simples e robusta:
 *  - Lista de callbacks nomeados
 *  - flush(commonAncestorBlock?) chama todos sequencialmente
 *  - Erros em callbacks são swallowed (não interrompem outros)
 *  - Logs estruturados pra debug
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export type CacheFlushFn = (commonAncestorBlock?: bigint) => void | Promise<void>;

interface RegisteredCache {
  name: string;
  flush: CacheFlushFn;
}

export interface CacheInvalidatorOpts {
  logger?: LoggerLike;
}

export interface InvalidationStats {
  total_invalidations: number;
  last_invalidated_at: number | null;
  caches_registered: number;
}

/**
 * Hub central de invalidação.
 *
 * Uso típico:
 *   const invalidator = new CacheInvalidator({ logger });
 *
 *   // No boot dos caches:
 *   invalidator.register('slippage-cache', () => slippageCache.flush());
 *   invalidator.register('aave-oracle', (ancestor) => aaveOracle.flushFromBlock(ancestor));
 *   invalidator.register('comet-cache', () => cometCache.markStale());
 *
 *   // Wire ao FinalityTracker:
 *   finalityTracker.onReorg(async (ev) => {
 *     await invalidator.flushAll(ev.commonAncestorBlock);
 *   });
 */
export class CacheInvalidator {
  private readonly caches: RegisteredCache[] = [];
  private readonly logger: LoggerLike | undefined;
  private total_invalidations = 0;
  private last_invalidated_at: number | null = null;

  constructor(opts: CacheInvalidatorOpts = {}) {
    this.logger = opts.logger;
  }

  /**
   * Registra um cache pra ser invalidado em reorgs.
   * Idempotente — re-registrar com mesmo nome substitui callback.
   */
  register(name: string, flush: CacheFlushFn): void {
    // Remove duplicate
    const existingIdx = this.caches.findIndex((c) => c.name === name);
    if (existingIdx >= 0) {
      this.caches.splice(existingIdx, 1);
    }
    this.caches.push({ name, flush });
    this.logger?.debug({ name, total: this.caches.length }, 'CacheInvalidator: cache registrado');
  }

  /**
   * Remove cache do registry.
   */
  unregister(name: string): boolean {
    const idx = this.caches.findIndex((c) => c.name === name);
    if (idx < 0) return false;
    this.caches.splice(idx, 1);
    return true;
  }

  /**
   * Invalida TODOS caches registrados. Chamado por FinalityTracker.onReorg.
   *
   * Estratégia:
   *  - Promise.allSettled pra rodar em paralelo (caches são independentes)
   *  - Erros em 1 cache não interrompem outros
   *  - Log estruturado por cache
   */
  async flushAll(commonAncestorBlock?: bigint): Promise<void> {
    if (this.caches.length === 0) {
      this.logger?.debug('CacheInvalidator: nenhum cache registrado pra invalidar');
      return;
    }

    const start = Date.now();
    this.logger?.info(
      {
        cachesCount: this.caches.length,
        commonAncestor: commonAncestorBlock?.toString(),
      },
      `♻️  CacheInvalidator: invalidando ${this.caches.length} caches`,
    );

    const results = await Promise.allSettled(
      this.caches.map(async (cache) => {
        try {
          await cache.flush(commonAncestorBlock);
          return { name: cache.name, ok: true };
        } catch (err) {
          throw new Error(`${cache.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

    const failed = results
      .map((r, i) => ({ result: r, name: this.caches[i]!.name }))
      .filter((x) => x.result.status === 'rejected');

    if (failed.length > 0) {
      this.logger?.warn(
        {
          failedCaches: failed.map((f) => f.name),
          errors: failed.map((f) => (f.result as PromiseRejectedResult).reason),
        },
        `CacheInvalidator: ${failed.length}/${this.caches.length} flushes falharam`,
      );
    }

    this.total_invalidations++;
    this.last_invalidated_at = Date.now();

    this.logger?.info(
      { durationMs: Date.now() - start, total_invalidations: this.total_invalidations },
      '♻️  CacheInvalidator: flushAll completed',
    );
  }

  /**
   * Stats pra readiness probe / observability.
   */
  stats(): InvalidationStats {
    return {
      total_invalidations: this.total_invalidations,
      last_invalidated_at: this.last_invalidated_at,
      caches_registered: this.caches.length,
    };
  }

  /**
   * Lista nomes dos caches registrados (debug).
   */
  registeredNames(): string[] {
    return this.caches.map((c) => c.name);
  }
}
