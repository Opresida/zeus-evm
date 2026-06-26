/**
 * Tests pra OrphanRecoveryManager + ReorgAnalytics (Item 9 R5+R7).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  OrphanRecoveryManager,
  ReorgAnalytics,
  TxStateMachine,
  type ReorgEvent,
  type OrphanContext,
} from '../src/finality';

describe('OrphanRecoveryManager — Item 9 R5', () => {
  function makeContext(overrides: Partial<OrphanContext> = {}): OrphanContext {
    return {
      operationKey: 'test:op',
      validateOpportunity: vi.fn(async () => true),
      resubmit: vi.fn(async () => '0xnew' as `0x${string}`),
      submittedAt: Date.now(),
      ...overrides,
    };
  }

  function makeReorgEvent(orphanedBlocks: bigint[]): ReorgEvent {
    return {
      detectedAt: Date.now(),
      commonAncestorBlock: orphanedBlocks[0]! - 1n,
      depth: orphanedBlocks.length,
      orphanedBlocks: orphanedBlocks.map((number) => ({
        number,
        hash: ('0x' + number.toString(16)) as `0x${string}`,
        parentHash: '0x0' as `0x${string}`,
        timestamp: Date.now(),
        miner: '0xbuilder' as `0x${string}`,
      })),
      newBlocks: [],
    };
  }

  it('registerSubmission + onReorg + recovery sucesso', async () => {
    const sm = new TxStateMachine();
    sm.recordSubmitted({ txHash: '0xa1' as `0x${string}`, operationKey: 'op-1' });
    sm.recordIncluded('0xa1' as `0x${string}`, 100n, '0xblock' as `0x${string}`);

    const manager = new OrphanRecoveryManager({ txStateMachine: sm });
    const ctx = makeContext({ operationKey: 'op-1' });
    manager.registerSubmission('0xa1' as `0x${string}`, ctx);

    await manager.onReorg(makeReorgEvent([100n]));

    expect(ctx.validateOpportunity).toHaveBeenCalled();
    expect(ctx.resubmit).toHaveBeenCalled();
    expect(manager.getStats().total_recoveries_succeeded).toBe(1);
  });

  it('skip recovery se oportunidade não vale mais', async () => {
    const sm = new TxStateMachine();
    sm.recordSubmitted({ txHash: '0xa1' as `0x${string}`, operationKey: 'op-1' });
    sm.recordIncluded('0xa1' as `0x${string}`, 100n, '0xblock' as `0x${string}`);

    const manager = new OrphanRecoveryManager({ txStateMachine: sm });
    const resubmitSpy = vi.fn();
    manager.registerSubmission('0xa1' as `0x${string}`, makeContext({
      validateOpportunity: vi.fn(async () => false),
      resubmit: resubmitSpy,
    }));

    await manager.onReorg(makeReorgEvent([100n]));

    expect(resubmitSpy).not.toHaveBeenCalled();
    expect(manager.getStats().total_recoveries_skipped).toBe(1);
  });

  it('skip recovery se tx muito velha (timeout)', async () => {
    const sm = new TxStateMachine();
    sm.recordSubmitted({ txHash: '0xa1' as `0x${string}`, operationKey: 'op-1' });
    sm.recordIncluded('0xa1' as `0x${string}`, 100n, '0xblock' as `0x${string}`);

    const manager = new OrphanRecoveryManager({
      txStateMachine: sm,
      recoveryTimeoutMs: 100,
    });
    const resubmitSpy = vi.fn();
    manager.registerSubmission('0xa1' as `0x${string}`, makeContext({
      submittedAt: Date.now() - 1000,
      resubmit: resubmitSpy,
    }));

    await manager.onReorg(makeReorgEvent([100n]));

    expect(resubmitSpy).not.toHaveBeenCalled();
    expect(manager.getStats().total_recoveries_skipped).toBe(1);
  });

  it('não recovery se tx não estava nos blocos órfãos', async () => {
    const sm = new TxStateMachine();
    sm.recordSubmitted({ txHash: '0xa1' as `0x${string}`, operationKey: 'op-1' });
    sm.recordIncluded('0xa1' as `0x${string}`, 200n, '0xblock' as `0x${string}`); // bloco 200

    const manager = new OrphanRecoveryManager({ txStateMachine: sm });
    const resubmitSpy = vi.fn();
    manager.registerSubmission('0xa1' as `0x${string}`, makeContext({
      resubmit: resubmitSpy,
    }));

    // Reorg afeta bloco 100, não 200
    await manager.onReorg(makeReorgEvent([100n]));

    expect(resubmitSpy).not.toHaveBeenCalled();
    expect(manager.getStats().total_orphans_detected).toBe(0);
  });

  it('releaseContext limpa armazenamento', () => {
    const sm = new TxStateMachine();
    const manager = new OrphanRecoveryManager({ txStateMachine: sm });
    manager.registerSubmission('0xa1' as `0x${string}`, makeContext());
    expect(manager.activeContexts()).toBe(1);
    manager.releaseContext('0xa1' as `0x${string}`);
    expect(manager.activeContexts()).toBe(0);
  });
});

describe('ReorgAnalytics — Item 9 R7', () => {
  function makeEvent(depth: number, hour: number, builder: string): ReorgEvent {
    // Ancora em ONTEM na hora UTC pedida — dentro da janela rolante (datas fixas envelheciam pra fora dela).
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(hour, 0, 0, 0);
    const ts = d.getTime();
    return {
      detectedAt: ts,
      commonAncestorBlock: 99n,
      depth,
      orphanedBlocks: Array.from({ length: depth }, (_, i) => ({
        number: 100n + BigInt(i),
        hash: '0x1' as `0x${string}`,
        parentHash: '0x0' as `0x${string}`,
        timestamp: ts,
        miner: builder as `0x${string}`,
      })),
      newBlocks: [],
    };
  }

  it('observe + aggregate retorna stats corretos', () => {
    const a = new ReorgAnalytics();
    a.observe(makeEvent(1, 14, '0xbuilder1'));
    a.observe(makeEvent(2, 14, '0xbuilder2'));
    a.observe(makeEvent(1, 3, '0xbuilder1'));

    const stats = a.aggregate();
    expect(stats.total_reorgs).toBe(3);
    expect(stats.avg_depth).toBeCloseTo(1.33, 1);
    expect(stats.max_depth).toBe(2);
    expect(stats.by_hour_utc[14]).toBe(2);
    expect(stats.by_hour_utc[3]).toBe(1);
  });

  it('topHostileBuilders ordena por count', () => {
    const a = new ReorgAnalytics();
    // Builder1: 3 reorgs (1-block cada)
    for (let i = 0; i < 3; i++) a.observe(makeEvent(1, 14, '0xb1'));
    // Builder2: 1 reorg (1-block)
    a.observe(makeEvent(1, 14, '0xb2'));

    const top = a.topHostileBuilders(2);
    expect(top[0]!.builder).toBe('0xb1');
    expect(top[0]!.orphans).toBe(3);
    expect(top[1]!.builder).toBe('0xb2');
    expect(top[1]!.orphans).toBe(1);
  });

  it('highRiskHours retorna horas com > threshold * avg', () => {
    const a = new ReorgAnalytics();
    // 24 reorgs total, avg/hora = 1
    // Hora 14: 4 reorgs (4x avg = high risk)
    for (let i = 0; i < 4; i++) a.observe(makeEvent(1, 14, '0xb'));
    // Resto: 1 cada hora (0-12 + 15-23 = 20 horas)
    for (let h = 0; h < 13; h++) a.observe(makeEvent(1, h, '0xb'));
    for (let h = 15; h < 22; h++) a.observe(makeEvent(1, h, '0xb'));

    const high = a.highRiskHours(2);
    expect(high).toContain(14);
  });

  it('window prune remove samples antigos', () => {
    const a = new ReorgAnalytics({ windowMs: 100 });
    // Sample antigo (timestamp explícito atrás da window)
    const oldEvt = makeEvent(1, 14, '0xb');
    oldEvt.detectedAt = Date.now() - 1000;
    oldEvt.orphanedBlocks[0]!.timestamp = Date.now() - 1000;
    a.observe(oldEvt);

    // Sample recente (timestamp agora)
    const recentEvt = makeEvent(1, 14, '0xb');
    recentEvt.detectedAt = Date.now();
    a.observe(recentEvt);

    expect(a.aggregate().total_reorgs).toBe(1);
  });

  it('snapshot + restore preserva data', () => {
    const a = new ReorgAnalytics();
    a.observe(makeEvent(1, 14, '0xb1'));
    a.observe(makeEvent(2, 15, '0xb2'));
    const snap = a.snapshot();

    const a2 = new ReorgAnalytics();
    a2.restore(snap);
    expect(a2.aggregate().total_reorgs).toBe(2);
  });
});
