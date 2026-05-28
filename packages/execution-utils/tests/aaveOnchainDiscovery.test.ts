/**
 * Smoke test do discovery on-chain Aave (Opção 3 — sem subgraph).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

import { fetchAaveBorrowersOnChain } from '@zeus-evm/aave-discovery';

const POOL = '0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7' as Address;
const A = '0xaAaA000000000000000000000000000000000001' as Address;
const B = '0xbBbB000000000000000000000000000000000001' as Address;

function makeClient(getLogs: ReturnType<typeof vi.fn>, currentBlock = 100_000n) {
  return {
    getLogs,
    getBlockNumber: vi.fn().mockResolvedValue(currentBlock),
  } as any;
}

describe('fetchAaveBorrowersOnChain — Opção 3', () => {
  it('coleta onBehalfOf únicos dos eventos Borrow', async () => {
    const getLogs = vi.fn().mockResolvedValue([
      { args: { onBehalfOf: A, user: A, reserve: POOL } },
      { args: { onBehalfOf: B, user: A, reserve: POOL } },
      { args: { onBehalfOf: A, user: B, reserve: POOL } }, // dup A
    ]);
    const borrowers = await fetchAaveBorrowersOnChain({ client: makeClient(getLogs), poolAddress: POOL });
    expect(borrowers.length).toBe(2); // A + B dedupe
    expect(borrowers).toContain(A.toLowerCase());
    expect(borrowers).toContain(B.toLowerCase());
  });

  it('usa onBehalfOf (não user) — quem carrega a dívida', async () => {
    const RELAYER = '0xcCcC000000000000000000000000000000000001' as Address;
    const getLogs = vi.fn().mockResolvedValue([
      { args: { onBehalfOf: A, user: RELAYER, reserve: POOL } },
    ]);
    const borrowers = await fetchAaveBorrowersOnChain({ client: makeClient(getLogs), poolAddress: POOL });
    expect(borrowers).toContain(A.toLowerCase());
    expect(borrowers).not.toContain(RELAYER.toLowerCase());
  });

  it('chunked: divide blockLookback em janelas free-tier (9999)', async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    await fetchAaveBorrowersOnChain({
      client: makeClient(getLogs, 100_000n),
      poolAddress: POOL,
      blockLookback: 30_000, // 30k blocos → 4 chunks de ~10k
    });
    // 30000 / 10000 = 3-4 chunks
    expect(getLogs.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('chunk falho não derruba — mantém o que coletou', async () => {
    let call = 0;
    const getLogs = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve([{ args: { onBehalfOf: A, user: A } }]);
      throw new Error('RPC range limit');
    });
    const borrowers = await fetchAaveBorrowersOnChain({
      client: makeClient(getLogs, 100_000n),
      poolAddress: POOL,
      blockLookback: 30_000,
    });
    // Apesar de chunks falharem, mantém A do primeiro chunk
    expect(borrowers).toContain(A.toLowerCase());
  });

  it('zero eventos → array vazio', async () => {
    const getLogs = vi.fn().mockResolvedValue([]);
    const borrowers = await fetchAaveBorrowersOnChain({ client: makeClient(getLogs), poolAddress: POOL });
    expect(borrowers).toEqual([]);
  });
});
