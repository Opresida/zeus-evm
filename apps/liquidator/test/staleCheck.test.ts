/**
 * Stale check Moonwell/Morpho (Fase Motor 1 mainnet) — re-checagem pré-dispatch, fail-open.
 */
import { describe, expect, it } from 'vitest';
import { isMoonwellStillLiquidatable, isMorphoStillLiquidatable } from '../src/staleCheck';

const ADDR = '0x0000000000000000000000000000000000000001' as `0x${string}`;
const MARKET_ID = `0x${'00'.repeat(32)}` as `0x${string}`;

// Mock mínimo de PublicClient — as funções só usam client.readContract.
const clientReturning = (value: unknown) => ({ readContract: async () => value }) as never;
const clientThrowing = () => ({ readContract: async () => { throw new Error('rpc down'); } }) as never;

describe('staleCheck Moonwell', () => {
  it('shortfall > 0 → ainda liquidável', async () => {
    const r = await isMoonwellStillLiquidatable({ client: clientReturning([0n, 0n, 123n]), comptroller: ADDR, borrower: ADDR });
    expect(r.stillLiquidatable).toBe(true);
  });
  it('shortfall = 0 → não mais liquidável (position resolvida)', async () => {
    const r = await isMoonwellStillLiquidatable({ client: clientReturning([0n, 50n, 0n]), comptroller: ADDR, borrower: ADDR });
    expect(r.stillLiquidatable).toBe(false);
    expect(r.reason).toContain('shortfall');
  });
  it('RPC error → fail-open (assume liquidável, não trava oportunidade)', async () => {
    const r = await isMoonwellStillLiquidatable({ client: clientThrowing(), comptroller: ADDR, borrower: ADDR });
    expect(r.stillLiquidatable).toBe(true);
  });
});

describe('staleCheck Morpho (re-read fresh)', () => {
  const base = {
    morpho: ADDR,
    marketId: MARKET_ID,
    borrower: ADDR,
    market: { totalBorrowAssets: 1_000_000n, totalBorrowShares: 1_000_000n },
    collateralPrice: 1n,
    lltv: 800_000_000_000_000_000n, // 0.8e18
  };
  it('borrowShares=0 (repago) → não mais liquidável', async () => {
    const r = await isMorphoStillLiquidatable({ ...base, client: clientReturning([0n, 0n, 0n]) });
    expect(r.stillLiquidatable).toBe(false);
  });
  it('borrowShares grande vs colateral mínimo → liquidável (re-read confirma)', async () => {
    const r = await isMorphoStillLiquidatable({ ...base, client: clientReturning([0n, 1_000_000n, 1n]) });
    expect(r.stillLiquidatable).toBe(true);
  });
  it('RPC error → fail-open', async () => {
    const r = await isMorphoStillLiquidatable({ ...base, client: clientThrowing() });
    expect(r.stillLiquidatable).toBe(true);
  });
});
