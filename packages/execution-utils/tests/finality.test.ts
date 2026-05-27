/**
 * Smoke test do FinalityTracker + TxStateMachine (Item 9 R1+R2).
 *
 * FinalityTracker testes usam mock client (não fork) pra ser determinístico.
 * Cenários:
 *  - Sequência normal (sem reorg)
 *  - Reorg 1-block detectado
 *  - Circuit breaker ativa após N reorgs
 *
 * TxStateMachine testa transições + dedup + retry policy.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FinalityTracker,
  TxStateMachine,
  type BlockSnapshot,
  type ReorgEvent,
} from '../src/finality';

// ─── Mock client helper ──────────────────────────────────────────────────

function makeMockClient(blocks: Array<{ number: bigint; hash: string; parentHash: string }>) {
  let idx = 0;
  return {
    async getBlock(opts?: { blockTag?: string; blockHash?: string }) {
      if (opts?.blockHash) {
        const found = blocks.find((b) => b.hash === opts.blockHash);
        if (!found) throw new Error('block not found by hash');
        return {
          number: found.number,
          hash: found.hash,
          parentHash: found.parentHash,
          timestamp: 1000n,
          miner: '0x0',
        };
      }
      const block = blocks[Math.min(idx, blocks.length - 1)];
      idx++;
      return {
        number: block!.number,
        hash: block!.hash,
        parentHash: block!.parentHash,
        timestamp: 1000n,
        miner: '0x0',
      };
    },
  } as any;
}

// ─── FinalityTracker ─────────────────────────────────────────────────────

describe('FinalityTracker — Item 9 R1', () => {
  it('detecta reorg 1-block quando hash do mesmo number muda', async () => {
    // Sequência: 100(a) → 101(b, parent=a) → 101(c, parent=a) = REORG no 101
    const client = makeMockClient([
      { number: 100n, hash: '0xa', parentHash: '0x0' },
      { number: 101n, hash: '0xb', parentHash: '0xa' },
      { number: 101n, hash: '0xc', parentHash: '0xa' }, // reorg!
    ]);

    const tracker = new FinalityTracker({ client, pollIntervalMs: 9999 });
    (tracker as any).running = true;
    const reorgs: ReorgEvent[] = [];
    tracker.onReorg((ev) => reorgs.push(ev));

    // Manualmente dispara 3 polls (não usa start() pra teste determinístico)
    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();

    expect(reorgs).toHaveLength(1);
    expect(reorgs[0]?.depth).toBe(1);
    expect(reorgs[0]?.orphanedBlocks[0]?.hash).toBe('0xb');
    expect(reorgs[0]?.newBlocks[0]?.hash).toBe('0xc');
  });

  it('sequência normal não dispara reorg', async () => {
    const client = makeMockClient([
      { number: 100n, hash: '0xa', parentHash: '0x0' },
      { number: 101n, hash: '0xb', parentHash: '0xa' },
      { number: 102n, hash: '0xc', parentHash: '0xb' },
    ]);

    const tracker = new FinalityTracker({ client, pollIntervalMs: 9999 });
    (tracker as any).running = true;
    const reorgs: ReorgEvent[] = [];
    tracker.onReorg((ev) => reorgs.push(ev));

    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();

    expect(reorgs).toHaveLength(0);
    expect(tracker.stats().trackedBlocks).toBe(3);
    expect(tracker.stats().latestBlock).toBe(102n);
  });

  it('circuit breaker ativa após threshold reorgs em window', async () => {
    // Sequência com 3 reorgs no mesmo bloco — circuit breaker = 2
    const client = makeMockClient([
      { number: 100n, hash: '0xa', parentHash: '0x0' },
      { number: 101n, hash: '0xb', parentHash: '0xa' },
      { number: 101n, hash: '0xc', parentHash: '0xa' }, // reorg 1
      { number: 101n, hash: '0xd', parentHash: '0xa' }, // reorg 2
      { number: 101n, hash: '0xe', parentHash: '0xa' }, // reorg 3
    ]);

    const tracker = new FinalityTracker({
      client,
      pollIntervalMs: 9999,
      reorgsForCircuitBreaker: 2,
      circuitBreakerWindowMs: 60_000,
    });
    (tracker as any).running = true;

    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();

    expect(tracker.isCircuitBreakerActive()).toBe(true);
    expect(tracker.stats().reorgsInWindow).toBeGreaterThanOrEqual(2);
  });

  it('skip silencioso quando mesmo bloco visto 2x', async () => {
    const client = makeMockClient([
      { number: 100n, hash: '0xa', parentHash: '0x0' },
      { number: 100n, hash: '0xa', parentHash: '0x0' }, // mesmo bloco
      { number: 100n, hash: '0xa', parentHash: '0x0' }, // mesmo bloco
    ]);

    const tracker = new FinalityTracker({ client, pollIntervalMs: 9999 });
    (tracker as any).running = true;
    const reorgs: ReorgEvent[] = [];
    tracker.onReorg((ev) => reorgs.push(ev));

    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();
    await (tracker as any)._pollOnce();

    expect(reorgs).toHaveLength(0);
    expect(tracker.stats().trackedBlocks).toBe(1);
  });
});

// ─── TxStateMachine ──────────────────────────────────────────────────────

describe('TxStateMachine — Item 9 R2', () => {
  it('transição submitted → mempool → soft_confirmed → confirmed → finalized', () => {
    const m = new TxStateMachine({
      policy: { confirmationsRequired: 2, finalizationRequired: 5, maxRetryAttempts: 3 },
    });

    const tx = '0xabc' as `0x${string}`;
    m.recordSubmitted({ txHash: tx, operationKey: 'aave-v3:0xborrower' });
    expect(m.get(tx)?.state).toBe('submitted');

    m.recordInMempool(tx);
    expect(m.get(tx)?.state).toBe('mempool');

    m.recordIncluded(tx, 100n, '0xblock' as `0x${string}`);
    expect(m.get(tx)?.state).toBe('soft_confirmed');
    expect(m.get(tx)?.confirmations).toBe(1);

    // latestBlock = 100 + 1 = 101 → confs = 2 → confirmed
    m.recordConfirmations(tx, 101n);
    expect(m.get(tx)?.state).toBe('confirmed');

    // latestBlock = 104 → confs = 5 → finalized
    m.recordConfirmations(tx, 104n);
    expect(m.get(tx)?.state).toBe('finalized');
  });

  it('hasActiveTxForOperation: dedup baseado em state ativo', () => {
    const m = new TxStateMachine();
    const tx = '0xabc' as `0x${string}`;
    const op = 'aave-v3:0xborrower';

    expect(m.hasActiveTxForOperation(op)).toBe(false);

    m.recordSubmitted({ txHash: tx, operationKey: op });
    expect(m.hasActiveTxForOperation(op)).toBe(true);

    // Finalizado não conta mais como ativo (libera nova submission)
    m.recordIncluded(tx, 100n, '0xblock' as `0x${string}`);
    m.recordConfirmations(tx, 200n);
    expect(m.get(tx)?.state).toBe('finalized');
    expect(m.hasActiveTxForOperation(op)).toBe(false);
  });

  it('orphan + retry: máximo de retryAttempts', () => {
    const m = new TxStateMachine({
      policy: { confirmationsRequired: 2, finalizationRequired: 5, maxRetryAttempts: 2 },
    });

    const op = 'aave-v3:0xborrower';
    const tx1 = '0x1' as `0x${string}`;
    const tx2 = '0x2' as `0x${string}`;
    const tx3 = '0x3' as `0x${string}`;
    const tx4 = '0x4' as `0x${string}`;

    m.recordSubmitted({ txHash: tx1, operationKey: op });
    m.recordOrphan(tx1, 'block reorged');
    expect(m.get(tx1)?.state).toBe('orphaned');

    // Retry 1: permitido (attempts=1)
    expect(m.recordRetry(tx1, tx2)).toBe(true);
    expect(m.get(tx1)?.state).toBe('retried');
    expect(m.get(tx2)?.retryAttempts).toBe(1);

    // Retry 2 do tx2: permitido (attempts=2 = limite)
    m.recordOrphan(tx2, 'reorged again');
    expect(m.recordRetry(tx2, tx3)).toBe(true);
    expect(m.get(tx3)?.retryAttempts).toBe(2);

    // Retry 3: NEGADO (excederia limite)
    m.recordOrphan(tx3, 'third time');
    expect(m.recordRetry(tx3, tx4)).toBe(false);
  });

  it('stats counta entries por state', () => {
    const m = new TxStateMachine();

    m.recordSubmitted({ txHash: '0x1' as `0x${string}`, operationKey: 'a' });
    m.recordSubmitted({ txHash: '0x2' as `0x${string}`, operationKey: 'b' });
    m.recordSubmitted({ txHash: '0x3' as `0x${string}`, operationKey: 'c' });
    m.recordInMempool('0x2' as `0x${string}`);
    m.recordIncluded('0x3' as `0x${string}`, 100n, '0xb' as `0x${string}`);
    m.recordConfirmations('0x3' as `0x${string}`, 200n);

    const s = m.stats();
    expect(s.submitted).toBe(1);
    expect(s.mempool).toBe(1);
    expect(s.finalized).toBe(1);
  });

  it('prune remove entries finalized antigas', async () => {
    const m = new TxStateMachine();

    m.recordSubmitted({ txHash: '0x1' as `0x${string}`, operationKey: 'a' });
    m.recordIncluded('0x1' as `0x${string}`, 100n, '0xb' as `0x${string}`);
    m.recordConfirmations('0x1' as `0x${string}`, 200n);

    // Espera 10ms então prune com maxAge=5ms
    await new Promise((r) => setTimeout(r, 10));
    const removed = m.prune(5);
    expect(removed).toBe(1);
    expect(m.get('0x1' as `0x${string}`)).toBeUndefined();
  });
});
