/**
 * Smoke test do GasOracle cache TTL (Grupo B).
 */

import { describe, expect, it, vi } from 'vitest';
import { GasOracle } from '../src/gasOracle';

function makeClient(getBlockNumber: ReturnType<typeof vi.fn>, getFeeHistory: ReturnType<typeof vi.fn>) {
  return { getBlockNumber, getFeeHistory } as any;
}

const baseFeeHistory = {
  baseFeePerGas: [50_000_000n, 50_000_000n, 50_000_000n, 50_000_000n, 50_000_000n],
  gasUsedRatio: [0.5],
  oldestBlock: 100n,
  reward: [],
};

describe('GasOracle cache TTL — Grupo B', () => {
  it('1ª chamada faz getBlockNumber + getFeeHistory', async () => {
    const getBlockNumber = vi.fn().mockResolvedValue(100n);
    const getFeeHistory = vi.fn().mockResolvedValue(baseFeeHistory);
    const oracle = new GasOracle({ priorityFeeGwei: 0.001, maxFeeMultiplier: 2 });

    const fees = await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));
    expect(fees.baseFeePerGas).toBe(50_000_000n);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    expect(getFeeHistory).toHaveBeenCalledTimes(1);
  });

  it('2ª chamada dentro do TTL: ZERO RPC (cache temporal fast path)', async () => {
    const getBlockNumber = vi.fn().mockResolvedValue(100n);
    const getFeeHistory = vi.fn().mockResolvedValue(baseFeeHistory);
    const oracle = new GasOracle({ priorityFeeGwei: 0.001, maxFeeMultiplier: 2, cacheTtlMs: 2000 });

    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));
    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));
    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));

    expect(getBlockNumber).toHaveBeenCalledTimes(1); // só na primeira
    expect(getFeeHistory).toHaveBeenCalledTimes(1);

    const stats = oracle.cacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1); // primeira call sempre é miss
  });

  it('após TTL expirar mas mesmo bloco: 1 getBlockNumber, ZERO getFeeHistory', async () => {
    vi.useFakeTimers();
    const getBlockNumber = vi.fn().mockResolvedValue(100n);
    const getFeeHistory = vi.fn().mockResolvedValue(baseFeeHistory);
    const oracle = new GasOracle({ priorityFeeGwei: 0.001, maxFeeMultiplier: 2, cacheTtlMs: 1000 });

    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));
    vi.advanceTimersByTime(1500); // expira TTL
    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));

    expect(getBlockNumber).toHaveBeenCalledTimes(2); // revalida
    expect(getFeeHistory).toHaveBeenCalledTimes(1); // mas mesmo bloco, não refetch fees
    vi.useRealTimers();
  });

  it('bloco mudou: full refresh (getBlockNumber + getFeeHistory)', async () => {
    vi.useFakeTimers();
    let block = 100n;
    const getBlockNumber = vi.fn().mockImplementation(() => Promise.resolve(block));
    const getFeeHistory = vi.fn().mockResolvedValue(baseFeeHistory);
    const oracle = new GasOracle({ priorityFeeGwei: 0.001, maxFeeMultiplier: 2, cacheTtlMs: 1000 });

    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));
    vi.advanceTimersByTime(1500);
    block = 101n; // novo bloco
    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));

    expect(getBlockNumber).toHaveBeenCalledTimes(2);
    expect(getFeeHistory).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('invalidateCache zera contadores e força refresh', async () => {
    const getBlockNumber = vi.fn().mockResolvedValue(100n);
    const getFeeHistory = vi.fn().mockResolvedValue(baseFeeHistory);
    const oracle = new GasOracle({ priorityFeeGwei: 0.001, maxFeeMultiplier: 2 });

    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));
    oracle.invalidateCache();
    await oracle.getFees(makeClient(getBlockNumber, getFeeHistory));

    expect(getFeeHistory).toHaveBeenCalledTimes(2);
  });
});
