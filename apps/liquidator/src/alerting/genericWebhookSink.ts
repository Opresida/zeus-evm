/**
 * Generic webhook sink — envia evento ZEUS como JSON POST pra qualquer URL.
 *
 * Útil pra:
 *   - Endpoint customizado seu (mini server local, n8n, etc)
 *   - Telegram bot (formato Telegram aceita JSON)
 *   - Futuro WebSocket gateway
 *
 * Não formata payload — envia evento tipado raw.
 * Pra Discord usar discordAdapter (que formata pra embeds).
 *
 * Filtros opcionais por severidade (ex: só critical/warn em produção pra evitar spam).
 */

import type { ZeusEvent, Severity } from '../events';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

export interface GenericWebhookSinkOpts {
  url: string;
  /** Filtro de severidades. Default: todas. Ex: ['warn', 'critical'] pra reduzir spam. */
  severities?: Severity[];
  /** Filtro de tipos. Default: todos. */
  eventTypes?: ZeusEvent['type'][];
  /** Timeout em ms pro POST. Default 5s. */
  timeoutMs?: number;
  logger?: LoggerLike;
}

export function createGenericWebhookSink(opts: GenericWebhookSinkOpts) {
  const { url, severities, eventTypes, timeoutMs = 5000, logger } = opts;

  return async (event: ZeusEvent): Promise<void> => {
    if (severities && !severities.includes(event.severity)) return;
    if (eventTypes && !eventTypes.includes(event.type)) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger?.warn(
          { url, status: res.status, eventType: event.type },
          `Generic webhook retornou ${res.status}`,
        );
      }
    } catch (err) {
      logger?.warn(
        {
          url,
          err: err instanceof Error ? err.message : err,
          eventType: event.type,
        },
        `Generic webhook falhou`,
      );
    }
  };
}
