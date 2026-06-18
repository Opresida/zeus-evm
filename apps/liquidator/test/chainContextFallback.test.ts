/**
 * Fase 1 (H2) — RPC fallback no liquidator.
 * Garante que getChainContext monta o client com e sem BASE_RPC_HTTP_FALLBACK (failover viem),
 * sem lançar, e que o primário continua sendo o rpcUrl reportado.
 */

import { describe, expect, it } from 'vitest';
import { getChainContext } from '../src/chainContext';
import type { LiquidatorEnv } from '../src/config';

// Env mínima pra Base em dryrun (getChainContext só lê um subconjunto dos campos).
function baseEnv(overrides: Partial<LiquidatorEnv> = {}): LiquidatorEnv {
  return {
    CHAIN_ID: 8453,
    BASE_RPC_HTTP: 'http://127.0.0.1:8545',
    AAVE_V3_BASE_SUBGRAPH_ID: 'dummy',
    LIQUIDATOR_MODE: 'dryrun',
    ...overrides,
  } as unknown as LiquidatorEnv;
}

describe('getChainContext — RPC fallback (H2)', () => {
  it('monta client SEM fallback (só primário)', () => {
    const ctx = getChainContext(baseEnv());
    expect(ctx.client).toBeDefined();
    expect(ctx.rpcUrl).toBe('http://127.0.0.1:8545');
    expect(ctx.wallet).toBeUndefined(); // dryrun
  });

  it('monta client COM fallback (failover) sem lançar', () => {
    const ctx = getChainContext(baseEnv({ BASE_RPC_HTTP_FALLBACK: 'http://127.0.0.1:8546' } as Partial<LiquidatorEnv>));
    expect(ctx.client).toBeDefined();
    expect(ctx.rpcUrl).toBe('http://127.0.0.1:8545'); // primário continua sendo o reportado
  });

  it('lança quando nem o primário está setado', () => {
    expect(() => getChainContext(baseEnv({ BASE_RPC_HTTP: undefined } as Partial<LiquidatorEnv>))).toThrow();
  });
});
