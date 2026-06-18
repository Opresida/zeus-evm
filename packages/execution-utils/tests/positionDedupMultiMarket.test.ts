/**
 * Smoke test da dedup key multi-market (Doutrina — Seamless vs Aave core).
 */

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { aavePositionKey, compoundPositionKey, PositionDedupTracker } from '../src/positionDedup';

const BORROWER = '0xAbC0000000000000000000000000000000000001' as Address;
const COMET = '0xC0meT00000000000000000000000000000000001' as Address;

describe('aavePositionKey multi-market — Doutrina', () => {
  it('default = aave-v3 (compat com comportamento anterior)', () => {
    expect(aavePositionKey('Base', BORROWER)).toBe(`Base:aave-v3:${BORROWER.toLowerCase()}`);
  });

  it('market label distingue fork de core (anti-colisão)', () => {
    const core = aavePositionKey('Base', BORROWER, 'aave-v3');
    const seamless = aavePositionKey('Base', BORROWER, 'seamless');
    expect(core).not.toBe(seamless);
    expect(seamless).toContain(':seamless:');
  });

  it('mesmo borrower em markets diferentes gera keys distintas', () => {
    const keys = new Set([
      aavePositionKey('Base', BORROWER, 'aave-v3'),
      aavePositionKey('Base', BORROWER, 'seamless'),
      aavePositionKey('Base', BORROWER, 'zerolend'),
    ]);
    expect(keys.size).toBe(3); // 3 keys únicas — sem colisão de dedup
  });

  it('compoundPositionKey mantém formato com comet', () => {
    expect(compoundPositionKey('Base', COMET, BORROWER))
      .toBe(`Base:compound-v3:${COMET.toLowerCase()}:${BORROWER.toLowerCase()}`);
  });
});

describe('PositionDedupTracker — contagem de supressões (Fase 6)', () => {
  it('check bloqueado incrementa suppressed por status', () => {
    const tracker = new PositionDedupTracker({ pendingTimeoutMs: 60_000, recentTtlMs: 60_000 });
    const key = aavePositionKey('Base', BORROWER, 'aave-v3');

    // Livre → não bloqueia, não conta.
    expect(tracker.check(key).blocked).toBe(false);
    expect(tracker.stats().suppressed).toEqual({ pending: 0, confirmed: 0, failed: 0 });

    // Confirmado → próximos checks são supressões (quase-duplicados evitados).
    tracker.markConfirmed(key, '0xabc');
    expect(tracker.check(key).blocked).toBe(true);
    expect(tracker.check(key).blocked).toBe(true);
    expect(tracker.stats().suppressed.confirmed).toBe(2);
    expect(tracker.stats().suppressed.failed).toBe(0);
  });
});
