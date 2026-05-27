/**
 * Tracer — Item 16B OB1 do checklist 16-items.
 *
 * Implementação minimalista compatível OTel-style usando `AsyncLocalStorage`
 * nativo do Node pra propagar trace context através de async chains.
 *
 * **Por que minimalista vs OpenTelemetry full:**
 *  - OTel SDK adiciona ~200kb + várias deps (resource detection, instrumentation)
 *  - Pra MVP só precisamos: trace_id + span_id + duration_ms + attributes
 *  - Interface compatível (Span, startSpan, end) → swap pra OTel quando precisar Jaeger
 *
 * Quando upgrade pra OTel real (item 16B OB1+ futuro):
 *  - Adicionar `@opentelemetry/sdk-node` + `@opentelemetry/exporter-jaeger`
 *  - Trocar este tracer por OTel API
 *  - Spans gravados no JSONL via structuredLogger continuam funcionando
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanData {
  trace_id: string;            // 32 chars hex
  span_id: string;             // 16 chars hex
  parent_span_id?: string;
  name: string;
  service: string;
  start_ms: number;
  end_ms?: number;
  duration_ms?: number;
  status: SpanStatus;
  status_message?: string;
  attributes: Record<string, unknown>;
}

interface TraceContext {
  trace_id: string;
  span_id: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export interface TracerOpts {
  serviceName: string;
  logger?: LoggerLike;
  /** Callback opcional pra emit span pra outros sinks (JSONL, OTLP, etc). */
  onSpanEnd?: (span: SpanData) => void;
}

/**
 * Span tipo OTel — leve mas com interface familiar.
 *
 * Uso:
 *   const span = tracer.startSpan('discovery_tick', { chain: 'Base' });
 *   try {
 *     await doWork();
 *     span.setAttribute('positions_found', 12);
 *     span.setStatus('ok');
 *   } catch (e) {
 *     span.setStatus('error', e.message);
 *     throw e;
 *   } finally {
 *     span.end();
 *   }
 */
export class Span {
  private data: SpanData;
  private ended = false;
  private readonly tracer: Tracer;

  constructor(tracer: Tracer, data: SpanData) {
    this.data = data;
    this.tracer = tracer;
  }

  setAttribute(key: string, value: unknown): this {
    this.data.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, unknown>): this {
    for (const k in attrs) this.data.attributes[k] = attrs[k];
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    this.data.status = status;
    if (message) this.data.status_message = message;
    return this;
  }

  end(): SpanData {
    if (this.ended) return this.data;
    this.ended = true;
    this.data.end_ms = Date.now();
    this.data.duration_ms = this.data.end_ms - this.data.start_ms;
    if (this.data.status === 'unset') this.data.status = 'ok';
    this.tracer._emitSpan(this.data);
    return this.data;
  }

  context(): TraceContext {
    return { trace_id: this.data.trace_id, span_id: this.data.span_id };
  }
}

/**
 * Tracer principal — startSpan + runInSpan helpers.
 *
 * `runInSpan` é o padrão recomendado: cria span, executa fn dentro do contexto,
 * fecha automaticamente (mesmo em erro), propaga via AsyncLocalStorage.
 */
export class Tracer {
  private readonly serviceName: string;
  private readonly logger: LoggerLike | undefined;
  private readonly onSpanEnd: ((span: SpanData) => void) | undefined;

  constructor(opts: TracerOpts) {
    this.serviceName = opts.serviceName;
    this.logger = opts.logger;
    this.onSpanEnd = opts.onSpanEnd;
  }

  /**
   * Inicia novo span. Se há trace_id no contexto async atual, herda.
   * Senão, gera novo trace_id (root span).
   */
  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    const parent = traceStorage.getStore();
    const trace_id = parent?.trace_id ?? this._generateTraceId();
    const span_id = this._generateSpanId();

    const data: SpanData = {
      trace_id,
      span_id,
      parent_span_id: parent?.span_id,
      name,
      service: this.serviceName,
      start_ms: Date.now(),
      status: 'unset',
      attributes,
    };

    return new Span(this, data);
  }

  /**
   * Executa fn dentro do span (padrão recomendado). Trace context propagado
   * via AsyncLocalStorage pra nested spans herdarem trace_id.
   */
  async runInSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, unknown> = {},
  ): Promise<T> {
    const span = this.startSpan(name, attributes);
    return traceStorage.run({ trace_id: span.context().trace_id, span_id: span.context().span_id }, async () => {
      try {
        const result = await fn(span);
        span.setStatus('ok');
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        span.setStatus('error', msg);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Versão sync de runInSpan.
   */
  runInSpanSync<T>(
    name: string,
    fn: (span: Span) => T,
    attributes: Record<string, unknown> = {},
  ): T {
    const span = this.startSpan(name, attributes);
    return traceStorage.run({ trace_id: span.context().trace_id, span_id: span.context().span_id }, () => {
      try {
        const result = fn(span);
        span.setStatus('ok');
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        span.setStatus('error', msg);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Pega contexto trace atual (pra correlation em structured logger).
   * Retorna undefined se fora de span.
   */
  currentContext(): TraceContext | undefined {
    return traceStorage.getStore();
  }

  /** Internal — chamado por Span.end() */
  _emitSpan(data: SpanData): void {
    this.logger?.debug(
      {
        trace_id: data.trace_id,
        span_id: data.span_id,
        parent_span_id: data.parent_span_id,
        name: data.name,
        duration_ms: data.duration_ms,
        status: data.status,
        ...data.attributes,
      },
      `📍 span ${data.name} ${data.duration_ms}ms`,
    );
    if (this.onSpanEnd) {
      try {
        this.onSpanEnd(data);
      } catch {
        // sink failed — não derruba bot
      }
    }
  }

  private _generateTraceId(): string {
    return randomBytes(16).toString('hex');
  }

  private _generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }
}
