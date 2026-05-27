/**
 * Smoke test do healthServer (Item 12 H8+H11).
 *
 * Valida que endpoints /healthz e /readyz respondem corretamente
 * com status HTTP esperado e payloads bem formados.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

import { startHealthServer, type ReadinessReport } from '../src/health';

describe('HealthServer — Item 12 H8+H11', () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    // Porta dinâmica (evita conflito em testes paralelos)
    port = 17000 + Math.floor(Math.random() * 1000);
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  it('/healthz responde 200 com payload de liveness', async () => {
    server = startHealthServer({
      serviceName: 'test-bot',
      port,
      host: '127.0.0.1',
      version: 'v1.2.3',
      readinessProvider: () => ({
        status: 'ok',
        checks: {},
        dispatchesPaused: false,
      }),
    });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('test-bot');
    expect(body.version).toBe('v1.2.3');
    expect(body.pid).toBeGreaterThan(0);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('/readyz responde 200 quando status=ok', async () => {
    const report: ReadinessReport = {
      status: 'ok',
      checks: {
        pnl: { ok: true, netPnlUsd: 100 },
      },
      dispatchesPaused: false,
    };

    server = startHealthServer({
      serviceName: 'test-bot',
      port,
      readinessProvider: () => report,
    });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.pnl.ok).toBe(true);
    expect(body.checks.pnl.netPnlUsd).toBe(100);
  });

  it('/readyz responde 503 quando status=critical (load balancer remove host)', async () => {
    const report: ReadinessReport = {
      status: 'critical',
      checks: {
        pnl: { ok: false, reason: 'kill switch' },
      },
      dispatchesPaused: true,
      pausedReasons: ['kill_switch'],
    };

    server = startHealthServer({
      serviceName: 'test-bot',
      port,
      readinessProvider: () => report,
    });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('critical');
    expect(body.dispatchesPaused).toBe(true);
  });

  it('/readyz responde 200 quando status=degraded (ainda funcional)', async () => {
    const report: ReadinessReport = {
      status: 'degraded',
      checks: {
        gas_reserve: { ok: false, reason: 'warn', balanceUsd: 10 },
      },
      dispatchesPaused: false,
    };

    server = startHealthServer({
      serviceName: 'test-bot',
      port,
      readinessProvider: () => report,
    });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('degraded');
  });

  it('endpoint desconhecido retorna 404', async () => {
    server = startHealthServer({
      serviceName: 'test-bot',
      port,
      readinessProvider: () => ({
        status: 'ok',
        checks: {},
        dispatchesPaused: false,
      }),
    });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('readinessProvider async funciona', async () => {
    server = startHealthServer({
      serviceName: 'test-bot',
      port,
      readinessProvider: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          status: 'ok',
          checks: { async_check: { ok: true } },
          dispatchesPaused: false,
        };
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.checks.async_check.ok).toBe(true);
  });

  it('readinessProvider que joga erro retorna 500', async () => {
    server = startHealthServer({
      serviceName: 'test-bot',
      port,
      readinessProvider: () => {
        throw new Error('boom');
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(res.status).toBe(500);
  });
});
