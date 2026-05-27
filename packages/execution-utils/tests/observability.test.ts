/**
 * Smoke test do Observability module (Item 16B OB1+OB5).
 */

import { describe, expect, it, vi } from 'vitest';

import { Tracer, createStructuredLogger } from '../src/observability';

describe('Tracer — Item 16B OB1', () => {
  it('startSpan retorna span com IDs únicos', () => {
    const tracer = new Tracer({ serviceName: 'test' });
    const s1 = tracer.startSpan('op1');
    const s2 = tracer.startSpan('op2');

    expect(s1.context().trace_id).not.toBe(s2.context().trace_id);
    expect(s1.context().span_id).not.toBe(s2.context().span_id);
    expect(s1.context().trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(s1.context().span_id).toMatch(/^[0-9a-f]{16}$/);

    s1.end();
    s2.end();
  });

  it('runInSpan propaga trace_id pra nested spans', async () => {
    const tracer = new Tracer({ serviceName: 'test' });
    let outerTraceId = '';
    let innerTraceId = '';

    await tracer.runInSpan('outer', async (outer) => {
      outerTraceId = outer.context().trace_id;
      await tracer.runInSpan('inner', async (inner) => {
        innerTraceId = inner.context().trace_id;
      });
    });

    expect(innerTraceId).toBe(outerTraceId);
  });

  it('span end captura duration_ms', async () => {
    const captured: any[] = [];
    const tracer = new Tracer({
      serviceName: 'test',
      onSpanEnd: (span) => captured.push(span),
    });

    await tracer.runInSpan('slow_op', async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].duration_ms).toBeGreaterThanOrEqual(15);
    expect(captured[0].status).toBe('ok');
  });

  it('span error captura status + message', async () => {
    const captured: any[] = [];
    const tracer = new Tracer({
      serviceName: 'test',
      onSpanEnd: (span) => captured.push(span),
    });

    await expect(
      tracer.runInSpan('failing_op', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(captured).toHaveLength(1);
    expect(captured[0].status).toBe('error');
    expect(captured[0].status_message).toBe('boom');
  });

  it('setAttribute + setAttributes funcionam', async () => {
    const captured: any[] = [];
    const tracer = new Tracer({
      serviceName: 'test',
      onSpanEnd: (span) => captured.push(span),
    });

    await tracer.runInSpan('op', async (span) => {
      span.setAttribute('borrower', '0xabc');
      span.setAttributes({ profit_usd: 12.5, chain: 'Base' });
    });

    expect(captured[0].attributes).toMatchObject({
      borrower: '0xabc',
      profit_usd: 12.5,
      chain: 'Base',
    });
  });

  it('currentContext retorna undefined fora de span', () => {
    const tracer = new Tracer({ serviceName: 'test' });
    expect(tracer.currentContext()).toBeUndefined();
  });

  it('currentContext retorna ctx dentro de runInSpan', async () => {
    const tracer = new Tracer({ serviceName: 'test' });
    let ctxInside: any = null;
    await tracer.runInSpan('op', async () => {
      ctxInside = tracer.currentContext();
    });
    expect(ctxInside).not.toBeNull();
    expect(ctxInside.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('StructuredLogger — Item 16B OB5', () => {
  it('adiciona service tag em todos logs', () => {
    const calls: any[] = [];
    const base = {
      debug: (data: any, msg?: any) => calls.push({ level: 'debug', data, msg }),
      info: (data: any, msg?: any) => calls.push({ level: 'info', data, msg }),
      warn: (data: any, msg?: any) => calls.push({ level: 'warn', data, msg }),
      error: (data: any, msg?: any) => calls.push({ level: 'error', data, msg }),
      fatal: (data: any, msg?: any) => calls.push({ level: 'fatal', data, msg }),
    };

    const log = createStructuredLogger({ baseLogger: base, service: 'liquidator' });
    log.info({ borrower: '0xabc' }, 'liq');

    expect(calls[0].data.service).toBe('liquidator');
    expect(calls[0].data.borrower).toBe('0xabc');
    expect(calls[0].msg).toBe('liq');
  });

  it('injeta trace_id quando dentro de span', async () => {
    const calls: any[] = [];
    const base = {
      info: (data: any, msg?: any) => calls.push({ data, msg }),
      debug: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    const tracer = new Tracer({ serviceName: 'svc' });
    const log = createStructuredLogger({ baseLogger: base, service: 'svc', tracer });

    await tracer.runInSpan('op', async () => {
      log.info({ x: 1 }, 'inside');
    });
    log.info({ y: 2 }, 'outside');

    expect(calls[0].data.trace_id).toBeDefined();
    expect(calls[0].data.x).toBe(1);
    expect(calls[1].data.trace_id).toBeUndefined();
    expect(calls[1].data.y).toBe(2);
  });

  it('staticFields são preservados', () => {
    const calls: any[] = [];
    const base = {
      info: (data: any) => calls.push(data),
      debug: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    const log = createStructuredLogger({
      baseLogger: base,
      service: 'svc',
      staticFields: { chain: 'Base', mode: 'mainnet' },
    });
    log.info({ borrower: '0x123' }, 'msg');

    expect(calls[0].chain).toBe('Base');
    expect(calls[0].mode).toBe('mainnet');
    expect(calls[0].borrower).toBe('0x123');
  });

  it('child cria logger com fields adicionais', () => {
    const calls: any[] = [];
    const base = {
      info: (data: any) => calls.push(data),
      debug: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    const parent = createStructuredLogger({
      baseLogger: base,
      service: 'svc',
      staticFields: { chain: 'Base' },
    });
    const child = parent.child({ component: 'aave-pipeline' });

    child.info({ borrower: '0x1' }, 'msg');

    expect(calls[0].service).toBe('svc');
    expect(calls[0].chain).toBe('Base');
    expect(calls[0].component).toBe('aave-pipeline');
    expect(calls[0].borrower).toBe('0x1');
  });
});
