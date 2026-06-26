/**
 * Motor 1 — controle remoto de execução (toggle do Frontend → bot) via engine_control.
 * Foca no comportamento FAIL-SAFE: na menor incerteza, fica TRAVADO (false). Gateia o Motor 1
 * inteiro (liquidação clássica + pré-liquidação Morpho).
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchEngineControlEnabled } from '../src/engineControl';

const base = { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'key', motor: 'motor1' };

function mockFetch(impl: () => Promise<Partial<Response>>): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('fetchEngineControlEnabled (fail-safe, motor1)', () => {
  it('sem URL/key → false (travado permanente)', async () => {
    expect(await fetchEngineControlEnabled({ motor: 'motor1' })).toBe(false);
    expect(await fetchEngineControlEnabled({ supabaseUrl: 'https://x', motor: 'motor1' })).toBe(false);
  });

  it('liga SÓ com execution_enabled === true exato', async () => {
    const fetchImpl = mockFetch(async () => ({ ok: true, json: async () => [{ execution_enabled: true }] }));
    expect(await fetchEngineControlEnabled({ ...base, fetchImpl })).toBe(true);
  });

  it('valor truthy não-booleano (1, "true") → false', async () => {
    for (const v of [1, 'true', 'yes', {}]) {
      const fetchImpl = mockFetch(async () => ({ ok: true, json: async () => [{ execution_enabled: v }] }));
      expect(await fetchEngineControlEnabled({ ...base, fetchImpl })).toBe(false);
    }
  });

  it('resposta vazia / linha ausente → false', async () => {
    const fetchImpl = mockFetch(async () => ({ ok: true, json: async () => [] }));
    expect(await fetchEngineControlEnabled({ ...base, fetchImpl })).toBe(false);
  });

  it('HTTP não-ok (4xx/5xx) → false', async () => {
    const fetchImpl = mockFetch(async () => ({ ok: false, json: async () => [{ execution_enabled: true }] }));
    expect(await fetchEngineControlEnabled({ ...base, fetchImpl })).toBe(false);
  });

  it('erro de rede / JSON malformado → false', async () => {
    const boom = mockFetch(async () => {
      throw new Error('network');
    });
    expect(await fetchEngineControlEnabled({ ...base, fetchImpl: boom })).toBe(false);
    const badJson = mockFetch(async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    }));
    expect(await fetchEngineControlEnabled({ ...base, fetchImpl: badJson })).toBe(false);
  });

  it('desligar (false) é respeitado', async () => {
    const fetchImpl = mockFetch(async () => ({ ok: true, json: async () => [{ execution_enabled: false }] }));
    expect(await fetchEngineControlEnabled({ ...base, fetchImpl })).toBe(false);
  });
});
