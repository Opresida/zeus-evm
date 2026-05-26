/**
 * Event Bus interno — emit/subscribe tipado de eventos ZEUS.
 *
 * Permite múltiplos subscribers (alerting webhook, future WebSocket pro mobile,
 * log estruturado, anomaly detector) sem acoplamento.
 *
 * Subscribers async são executados em paralelo via Promise.all — bot não trava
 * esperando webhook responder. Falha em 1 subscriber não derruba os outros.
 */

import type { ZeusEvent } from './events';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

export type EventHandler = (event: ZeusEvent) => Promise<void> | void;

export class EventBus {
  private subscribers: EventHandler[] = [];
  private logger: LoggerLike | undefined;

  constructor(logger?: LoggerLike) {
    this.logger = logger;
  }

  subscribe(handler: EventHandler): void {
    this.subscribers.push(handler);
  }

  /**
   * Emite evento pra todos os subscribers em paralelo.
   * Falha em um subscriber é logada mas não afeta os outros.
   * Não bloqueia o caller — fire-and-forget.
   */
  emit(event: ZeusEvent): void {
    if (this.subscribers.length === 0) return;

    // Fire-and-forget: cada subscriber roda em paralelo, erros isolados
    Promise.allSettled(
      this.subscribers.map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          this.logger?.warn(
            { err: err instanceof Error ? err.message : err, eventType: event.type },
            `EventBus subscriber falhou em ${event.type}`,
          );
        }
      }),
    ).catch(() => {
      // Promise.allSettled nunca rejeita, mas tipescript fica feliz
    });
  }

  /** Emit síncrono — aguarda todos terminarem. Usar em shutdown final. */
  async emitAwait(event: ZeusEvent): Promise<void> {
    if (this.subscribers.length === 0) return;
    await Promise.allSettled(this.subscribers.map((h) => h(event)));
  }

  subscriberCount(): number {
    return this.subscribers.length;
  }
}
