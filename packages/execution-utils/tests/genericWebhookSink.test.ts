/**
 * Fase 1 (cobertura de eventos do front) — secret do genericWebhookSink.
 * Garante que o header `x-zeus-secret` vai SÓ quando o secret está setado.
 */

import { describe, expect, it, vi } from 'vitest';
import { createGenericWebhookSink } from '../src/alerting/genericWebhookSink';
import type { ZeusEvent } from '../src/events';

const evt: ZeusEvent = {
  type: 'liquidator.boot',
  severity: 'info',
  timestamp: '2026-06-23T00:00:00.000Z',
  chain: 'Base',
  mode: 'dryrun',
  executorAddress: null,
  account: null,
} as ZeusEvent;

function mockFetch() {
  return vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
}

describe('genericWebhookSink — secret no header', () => {
  it('inclui x-zeus-secret quando secret setado', async () => {
    const f = mockFetch();
    vi.stubGlobal('fetch', f);
    const sink = createGenericWebhookSink({ url: 'https://x/api/ingest', secret: 's3cr3t' });
    await sink(evt);
    const headers = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as { headers: Record<string, string> };
    expect(headers.headers['x-zeus-secret']).toBe('s3cr3t');
    expect(headers.headers['Content-Type']).toBe('application/json');
    vi.unstubAllGlobals();
  });

  it('NÃO inclui x-zeus-secret quando secret ausente', async () => {
    const f = mockFetch();
    vi.stubGlobal('fetch', f);
    const sink = createGenericWebhookSink({ url: 'https://x/api/ingest' });
    await sink(evt);
    const headers = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as { headers: Record<string, string> };
    expect(headers.headers['x-zeus-secret']).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('respeita o filtro de severidade (não posta evento filtrado)', async () => {
    const f = mockFetch();
    vi.stubGlobal('fetch', f);
    const sink = createGenericWebhookSink({ url: 'https://x', secret: 's', severities: ['critical'] });
    await sink(evt); // info → filtrado
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(0);
    vi.unstubAllGlobals();
  });
});
