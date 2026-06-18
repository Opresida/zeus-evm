/**
 * Fase 5b — post-mortem de falhas: CompetitorResolver (quem nos ganhou) + BlockPositionTracker
 * (posição no bloco). Usa um client viem mockado (sem RPC real).
 */

import { describe, expect, it } from 'vitest';
import { CompetitorResolver } from '../src/analytics/competitorResolver';
import { BlockPositionTracker } from '../src/analytics/blockPositionTracker';
import type { FailureEvent } from '../src/analytics/failureSchema';

const AAVE_POOL = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const COMPETITOR = '0xc0mpetitor000000000000000000000000000001';
const OUR_BOT = '0xb0t00000000000000000000000000000000000001';

function failure(blockNumber: bigint, ourTxIndex: number): FailureEvent {
  return {
    id: 'f1', timestamp: Date.now(), chain: 'Base', mode: 'mainnet', protocol: 'aave-v3',
    category: 'reverted_on_chain', category_confidence: 0.9,
    our_tx_hash: '0xours', block_number: blockNumber.toString(), our_tx_index: ourTxIndex,
  } as FailureEvent;
}

describe('CompetitorResolver (Fase 5b)', () => {
  it('acha o competidor que tocou o mesmo target no bloco', async () => {
    const client = {
      async getBlock() {
        return {
          transactions: [
            { from: COMPETITOR, to: AAVE_POOL, hash: '0xwin', gas: 300_000n, maxPriorityFeePerGas: 2_000_000_000n },
            { from: OUR_BOT, to: AAVE_POOL, hash: '0xours' },
          ],
        };
      },
    } as any;

    const resolver = new CompetitorResolver({ client, targets: [AAVE_POOL as `0x${string}`], lookbackBlocks: 0 });
    const winner = await resolver.resolve(failure(100n, 1), OUR_BOT as `0x${string}`);
    expect(winner).not.toBeNull();
    expect(winner!.winner_sender.toLowerCase()).toBe(COMPETITOR);
    expect(winner!.winner_priority_fee_wei).toBe(2_000_000_000n);
  });

  it('retorna null quando só a nossa tx tocou o target', async () => {
    const client = {
      async getBlock() {
        return { transactions: [{ from: OUR_BOT, to: AAVE_POOL, hash: '0xours' }] };
      },
    } as any;
    const resolver = new CompetitorResolver({ client, targets: [AAVE_POOL as `0x${string}`], lookbackBlocks: 0 });
    expect(await resolver.resolve(failure(100n, 0), OUR_BOT as `0x${string}`)).toBeNull();
  });
});

describe('BlockPositionTracker (Fase 5b)', () => {
  it('calcula posição relativa + flags top/bottom', async () => {
    const txs = Array.from({ length: 10 }, (_, i) => `0xtx${i}`);
    txs[9] = '0xours'; // última tx do bloco → bottom 10%
    const client = {
      async getBlock() {
        return { transactions: txs };
      },
    } as any;
    const tracker = new BlockPositionTracker({ client });
    const pos = await tracker.resolve('0xours', 100n);
    expect(pos).not.toBeNull();
    expect(pos!.our_tx_index).toBe(9);
    expect(pos!.block_total_txs).toBe(10);
    expect(pos!.is_bottom_10pct).toBe(true);
    expect(pos!.is_top_10pct).toBe(false);
  });
});
