/**
 * EventIngester — hub central que recebe ZeusEvents e normaliza pra HistoricalEvent.
 *
 * Inscreve-se no EventBus interno → cada evento emitido vira candidato pra ingest.
 * Aplica mapping (ZeusEvent.type → EventCategory) + extrai métricas/identificadores.
 * Persiste batched via TimeseriesStore.
 *
 * Filosofia:
 *  - Não bloqueia hot path (ingest é fire-and-forget)
 *  - Schema-aware (mapeia cada tipo de evento pros campos relevantes)
 *  - Tolerante a falhas (erro no ingester NUNCA derruba o bot)
 *  - Drop on backpressure (se store falhar, perde event antes de bloquear ops)
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

import type { EventBus } from '../eventBus';
import type { ZeusEvent } from '../events';
import type { HistoricalEvent, EventCategory, EventMode, EventSeverity } from './intelligenceSchema';
import { computeTimeDimensions, generateEventId } from './intelligenceSchema';
import type { TimeseriesStore } from './timeseriesStore';

export interface EventIngesterOpts {
  store: TimeseriesStore;
  eventBus: EventBus;
  logger?: LoggerLike;
  /** Default 'Base' — usado quando event não traz chain. */
  defaultChain?: string;
}

export interface IngesterStats {
  eventsReceived: number;
  eventsIngested: number;
  eventsDropped: number;
  errors: number;
}

/**
 * Inscreve no EventBus + roteia eventos pro TimeseriesStore.
 *
 * Uso:
 *   const ingester = new EventIngester({ store, eventBus, logger });
 *   ingester.start();
 *   // ... bot roda, eventos são coletados automaticamente
 *   await ingester.stop();
 */
export class EventIngester {
  private readonly store: TimeseriesStore;
  private readonly eventBus: EventBus;
  private readonly logger: LoggerLike | undefined;
  private readonly defaultChain: string;

  private started = false;
  private stats: IngesterStats = {
    eventsReceived: 0,
    eventsIngested: 0,
    eventsDropped: 0,
    errors: 0,
  };

  constructor(opts: EventIngesterOpts) {
    this.store = opts.store;
    this.eventBus = opts.eventBus;
    this.logger = opts.logger;
    this.defaultChain = opts.defaultChain ?? 'Base';
  }

  /**
   * Inscreve no EventBus pra começar a coletar eventos.
   * EventBus atual não suporta unsubscribe — usamos flag `started` pra ignorar
   * eventos após stop(). Subscription persiste no bus mas vira no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.eventBus.subscribe((event: ZeusEvent) => {
      if (!this.started) return; // skip silencioso pós-stop
      this.stats.eventsReceived++;
      try {
        const historical = this._normalize(event);
        if (historical) {
          this.store.ingest(historical);
          this.stats.eventsIngested++;
        } else {
          this.stats.eventsDropped++;
        }
      } catch (err) {
        this.stats.errors++;
        // NUNCA propaga — ingester não pode quebrar o bot
        this.logger?.warn(
          {
            err: err instanceof Error ? err.message : err,
            eventType: event.type,
          },
          'EventIngester: erro normalizando evento (drop silencioso)',
        );
      }
    });

    this.logger?.info('📥 EventIngester ativo — coletando eventos pra historical store');
  }

  /**
   * Para de coletar + flush final do store.
   */
  async stop(): Promise<void> {
    this.started = false;
    await this.store.flush();
    this.logger?.info({ stats: this.stats }, '📥 EventIngester parado');
  }

  getStats(): IngesterStats {
    return { ...this.stats };
  }

  // ─── Normalize ZeusEvent → HistoricalEvent ──────────────────────────────

  private _normalize(event: ZeusEvent): HistoricalEvent | null {
    const timestamp = this._parseTimestamp(event.timestamp);
    if (timestamp === null) return null;

    const time = computeTimeDimensions(timestamp);
    const id = generateEventId(timestamp);

    const base = {
      id,
      timestamp,
      source_event_type: event.type,
      hour_utc: time.hour_utc,
      weekday: time.weekday,
      iso_week: time.iso_week,
      chain: event.chain ?? this.defaultChain,
      mode: event.mode as EventMode,
      severity: event.severity as EventSeverity,
    };

    switch (event.type) {
      case 'liquidator.boot':
        return {
          ...base,
          category: 'boot',
          payload: { executorAddress: event.executorAddress, account: event.account },
        };

      case 'liquidator.shutdown':
        return {
          ...base,
          category: 'shutdown',
          payload: { uptimeSec: event.uptimeSec, reason: event.reason },
        };

      case 'tx.confirmed': {
        // Detecta categoria: liquidation, backrun, arb (por protocol)
        let category: EventCategory = 'liquidation';
        if (event.protocol === 'aave-v3' || event.protocol === 'compound-v3' || event.protocol === 'morpho-blue') {
          category = 'liquidation';
        }
        return {
          ...base,
          category,
          protocol: event.protocol,
          borrower: event.borrower,
          tx_hash: event.txHash,
          block_number: BigInt(event.blockNumber),
          profit_usd: event.profitUsd ?? undefined,
          gas_usd: event.gasCostUsd,
          profit_delta_bps: event.profitDeltaBps,
          payload: {
            netProfitUsd: event.netProfitUsd,
          },
        };
      }

      case 'tx.reverted_on_chain':
        return {
          ...base,
          category: 'tx_reverted',
          protocol: event.protocol,
          borrower: event.borrower,
          tx_hash: event.txHash,
          block_number: BigInt(event.blockNumber),
          gas_usd: event.gasUsdLost,
          payload: { gasUsdLost: event.gasUsdLost },
        };

      case 'tx.reverted_pre_dispatch':
        return {
          ...base,
          category: 'pre_dispatch_reject',
          protocol: event.protocol,
          borrower: event.borrower,
          payload: { reason: event.reason },
        };

      case 'pnl.kill_switch_triggered':
        return {
          ...base,
          category: 'kill_switch',
          amount_usd: event.loss24hUsd,
          payload: {
            loss24hUsd: event.loss24hUsd,
            limitUsd: event.limitUsd,
            onChainKillResult: event.onChainKillResult,
          },
        };

      case 'failure.cooldown_activated':
        return {
          ...base,
          category: 'cooldown',
          payload: {
            consecutiveFailures: event.consecutiveFailures,
            cooldownSec: event.cooldownSec,
            lastFailureReason: event.lastFailureReason,
          },
        };

      case 'failure.cooldown_expired':
        return {
          ...base,
          category: 'cooldown',
          payload: { recovered: true },
        };

      case 'gas.alert':
        return {
          ...base,
          category: 'gas_reserve',
          amount_usd: event.balanceUsd,
          payload: {
            account: event.account,
            balanceEth: event.balanceEth,
            balanceUsd: event.balanceUsd,
            status: event.status,
          },
        };

      case 'gas.recovered':
        return {
          ...base,
          category: 'gas_reserve',
          amount_usd: event.balanceUsd,
          payload: {
            account: event.account,
            balanceEth: event.balanceEth,
            balanceUsd: event.balanceUsd,
            previousStatus: event.previousStatus,
            recovered: true,
          },
        };

      case 'discovery.tick_completed':
        return {
          ...base,
          category: 'discovery_tick',
          payload: {
            aavePositions: event.aavePositions,
            compoundPositions: event.compoundPositions,
            dispatched: event.dispatched,
            dryrun: event.dryrun,
            rejected: event.rejected,
            elapsedMs: event.elapsedMs,
          },
        };

      case 'whale.swap_detected':
        return {
          ...base,
          category: 'whale_swap',
          sender: event.sender ?? undefined,
          tx_hash: event.pendingTxHash,
          amount_usd: event.amountInUsd,
          payload: {
            venue: event.venue,
            tokenIn: event.tokenIn,
            tokenOut: event.tokenOut,
            amountIn: event.amountIn,
            router: event.router,
          },
        };

      case 'backrun.opportunity_found':
        return {
          ...base,
          category: 'opportunity_found',
          protocol: 'backrun',
          tx_hash: event.pendingTxHash,
          pair: event.pairId,
          profit_usd: event.expectedProfitUsd,
          slippage_bps: event.estimatedSlippageBps,
          payload: {
            buyVenue: event.buyVenue,
            sellVenue: event.sellVenue,
            opportunityScore: event.opportunityScore,
            riskAdjustedEvUsd: event.riskAdjustedEvUsd,
          },
        };

      case 'backrun.dispatched':
        return {
          ...base,
          category: 'backrun',
          protocol: 'backrun',
          tx_hash: 'pendingTxHash' in event ? (event as { pendingTxHash: `0x${string}` }).pendingTxHash : undefined,
          payload: { ...event } as Record<string, unknown>,
        };

      case 'backrun.rejected':
        return {
          ...base,
          category: 'opportunity_rejected',
          protocol: 'backrun',
          payload: { ...event } as Record<string, unknown>,
        };

      default: {
        // Catch-all pra eventos desconhecidos — não bloqueia, só log debug
        this.logger?.debug({ eventType: (event as { type: string }).type }, 'EventIngester: tipo desconhecido — drop');
        return null;
      }
    }
  }

  private _parseTimestamp(iso: string): number | null {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    return ms;
  }
}
