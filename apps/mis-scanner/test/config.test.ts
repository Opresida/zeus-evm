/**
 * Fase 4 (H5) — config zod do mis-scanner.
 * Garante que valores malformados FALHAM no boot (em vez de virar NaN → setInterval(0)/scanner mudo).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'MIS_SCAN_INTERVAL_MS', 'MIS_MIN_DIVERGENCE_BPS', 'MIS_CHAIN', 'MIS_DERIVE_TOKENS',
  'MIS_MAX_DERIVED_PAIRS', 'HEALTH_SERVER_PORT', 'MIS_FLASH_MIN_BPS',
];
function clear() {
  for (const k of KEYS) delete process.env[k];
}

afterEach(() => {
  clear();
  vi.resetModules();
});

async function freshLoad() {
  vi.resetModules();
  const mod = await import('../src/config');
  return mod.loadConfig();
}

describe('mis-scanner config (H5)', () => {
  it('defaults sãos quando nada setado', async () => {
    clear();
    const env = await freshLoad();
    expect(env.MIS_SCAN_INTERVAL_MS).toBe(12_000);
    expect(env.MIS_CHAIN).toBe('base');
    expect(env.MIS_DERIVE_TOKENS).toBe(true);
    // MIS_FLASH_MIN_BPS default = MIS_MIN_DIVERGENCE_BPS
    expect(env.MIS_FLASH_MIN_BPS).toBe(env.MIS_MIN_DIVERGENCE_BPS);
  });

  it('MIS_SCAN_INTERVAL_MS malformado (NaN) → LANÇA no boot', async () => {
    clear();
    process.env.MIS_SCAN_INTERVAL_MS = 'abc';
    await expect(freshLoad()).rejects.toThrow();
  });

  it('MIS_CHAIN inválido → LANÇA', async () => {
    clear();
    process.env.MIS_CHAIN = 'solana';
    await expect(freshLoad()).rejects.toThrow();
  });

  it('booleano "false" desliga; case-insensitive na chain', async () => {
    clear();
    process.env.MIS_DERIVE_TOKENS = 'false';
    process.env.MIS_CHAIN = 'AVALANCHE';
    const env = await freshLoad();
    expect(env.MIS_DERIVE_TOKENS).toBe(false);
    expect(env.MIS_CHAIN).toBe('avalanche');
  });
});
