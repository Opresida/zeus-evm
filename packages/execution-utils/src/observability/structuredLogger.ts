/**
 * Structured Logger — Item 16B OB5 do checklist 16-items.
 *
 * Wrap em volta de pino com:
 *  - Trace context auto-injection (trace_id/span_id do tracer ativo)
 *  - Service tag automático (liquidator/backrun-engine/scraper)
 *  - Campos canônicos pra correlação cross-component
 *
 * Mantém interface compatível com `LoggerLike` (debug/info/warn/error/fatal)
 * pra ser drop-in replacement do logger pino direto.
 */

import type { Tracer } from './tracer';

export interface StructuredLoggerOpts {
  /** Logger pino base — receberá os calls finais com campos enriquecidos. */
  baseLogger: any;
  /** Service tag pra todos logs (ex: 'liquidator'). */
  service: string;
  /** Tracer opcional pra auto-inject trace_id/span_id. */
  tracer?: Tracer;
  /** Campos fixos sempre adicionados (ex: chain, mode, version). */
  staticFields?: Record<string, unknown>;
}

/**
 * Wrapper de logger que:
 *  - Adiciona `service` em todos logs
 *  - Injeta `trace_id` + `span_id` do tracer ativo (se houver)
 *  - Merges `staticFields` configurados
 *  - Preserva campos do call original
 *
 * Uso:
 *   const log = createStructuredLogger({ baseLogger: pino, service: 'liquidator', tracer });
 *   log.info({ borrower: '0x...' }, 'liquidation submitted');
 *   // Saída:
 *   //   service=liquidator chain=Base trace_id=abc... borrower=0x... msg="liquidation submitted"
 */
export function createStructuredLogger(opts: StructuredLoggerOpts) {
  const { baseLogger, service, tracer, staticFields = {} } = opts;

  function enrich(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const traceCtx = tracer?.currentContext();
    return {
      service,
      ...staticFields,
      ...(traceCtx ? { trace_id: traceCtx.trace_id, span_id: traceCtx.span_id } : {}),
      ...extra,
    };
  }

  // Wrappers pra cada nível — interface compat com pino + LoggerLike
  return {
    debug(...args: unknown[]) {
      const [first, ...rest] = args;
      if (typeof first === 'object' && first !== null) {
        baseLogger.debug(enrich(first as Record<string, unknown>), ...rest);
      } else {
        baseLogger.debug(enrich({}), first as string, ...rest);
      }
    },
    info(...args: unknown[]) {
      const [first, ...rest] = args;
      if (typeof first === 'object' && first !== null) {
        baseLogger.info(enrich(first as Record<string, unknown>), ...rest);
      } else {
        baseLogger.info(enrich({}), first as string, ...rest);
      }
    },
    warn(...args: unknown[]) {
      const [first, ...rest] = args;
      if (typeof first === 'object' && first !== null) {
        baseLogger.warn(enrich(first as Record<string, unknown>), ...rest);
      } else {
        baseLogger.warn(enrich({}), first as string, ...rest);
      }
    },
    error(...args: unknown[]) {
      const [first, ...rest] = args;
      if (typeof first === 'object' && first !== null) {
        baseLogger.error(enrich(first as Record<string, unknown>), ...rest);
      } else {
        baseLogger.error(enrich({}), first as string, ...rest);
      }
    },
    fatal(...args: unknown[]) {
      const [first, ...rest] = args;
      if (typeof first === 'object' && first !== null) {
        baseLogger.fatal(enrich(first as Record<string, unknown>), ...rest);
      } else {
        baseLogger.fatal(enrich({}), first as string, ...rest);
      }
    },
    /** Cria child logger com campos extras (estilo pino) */
    child(extraFields: Record<string, unknown>) {
      return createStructuredLogger({
        baseLogger,
        service,
        tracer,
        staticFields: { ...staticFields, ...extraFields },
      });
    },
  };
}
