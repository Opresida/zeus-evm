/**
 * Smoke test do FailureCollector (Item 4 A1+A5).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FailureCollector, generateFailureId, type FailureEvent } from '../src/analytics';

function freshDir(): string {
  return join(
    tmpdir(),
    `zeus-failures-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
}

describe('FailureCollector — Item 4 A1+A5', () => {
  let baseDir: string;
  let collector: FailureCollector;

  beforeEach(() => {
    baseDir = freshDir();
    collector = new FailureCollector({ baseDir });
  });

  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  });

  it('record persiste failure no JSONL diário', () => {
    const ev: FailureEvent = {
      id: generateFailureId(Date.now()),
      timestamp: Date.now(),
      chain: 'Base',
      mode: 'dryrun',
      protocol: 'aave-v3',
      category: 'reverted_on_chain',
      category_confidence: 0.95,
      our_tx_hash: '0xabc123',
      our_gas_usd_lost: 0.42,
      block_number: '12345',
      expected_profit_usd: 12.5,
      payload: { extra: 'data' },
    };

    collector.record(ev);

    // File path determinístico (data UTC do timestamp)
    const d = new Date(ev.timestamp);
    const filePath = join(
      baseDir,
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}.jsonl`,
    );

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('reverted_on_chain');
    expect(content).toContain('0xabc123');
  });

  it('stats agrupa por category corretamente', () => {
    const categories: Array<'reverted_on_chain' | 'lost_race' | 'gas_outbid'> = [
      'reverted_on_chain',
      'reverted_on_chain',
      'lost_race',
      'gas_outbid',
    ];

    for (const cat of categories) {
      collector.record({
        id: generateFailureId(Date.now()),
        timestamp: Date.now(),
        chain: 'Base',
        mode: 'dryrun',
        category: cat,
        category_confidence: 0.9,
        our_gas_usd_lost: 0.5,
        payload: {},
      });
    }

    const stats = collector.stats();
    expect(stats.total).toBe(4);
    expect(stats.byCategory.reverted_on_chain).toBe(2);
    expect(stats.byCategory.lost_race).toBe(1);
    expect(stats.byCategory.gas_outbid).toBe(1);
    expect(stats.totalUsdLost).toBe(2.0); // 4 × 0.5
  });

  it('pruneOldEntries remove failures fora da window', () => {
    const collector2 = new FailureCollector({ baseDir, windowMs: 100 });

    // Failure antigo (timestamp 200ms atrás)
    collector2.record({
      id: generateFailureId(Date.now() - 200),
      timestamp: Date.now() - 200,
      chain: 'Base',
      mode: 'dryrun',
      category: 'reverted_on_chain',
      category_confidence: 1,
      our_gas_usd_lost: 1,
      payload: {},
    });

    // Failure recente (timestamp agora)
    collector2.record({
      id: generateFailureId(Date.now()),
      timestamp: Date.now(),
      chain: 'Base',
      mode: 'dryrun',
      category: 'lost_race',
      category_confidence: 1,
      our_gas_usd_lost: 2,
      payload: {},
    });

    // Stats: window=100ms, antigo já está fora
    const stats = collector2.stats();
    expect(stats.total).toBe(1);
    expect(stats.byCategory.lost_race).toBe(1);
    expect(stats.totalUsdLost).toBe(2);
  });

  it('recent retorna últimos N failures', () => {
    for (let i = 0; i < 5; i++) {
      collector.record({
        id: generateFailureId(Date.now() + i),
        timestamp: Date.now() + i,
        chain: 'Base',
        mode: 'dryrun',
        category: 'reverted_on_chain',
        category_confidence: 1,
        payload: { idx: i },
      });
    }

    const recent = collector.recent(3);
    expect(recent.length).toBe(3);
    expect(recent[2]?.payload.idx).toBe(4); // último em ordem
  });

  it('record com erro de IO NÃO derruba o bot (resilência)', () => {
    // Tenta um path inválido (sem permissão de criar)
    const badCollector = new FailureCollector({ baseDir: '/dev/null/nope' });

    // Não deve throw
    expect(() =>
      badCollector.record({
        id: generateFailureId(Date.now()),
        timestamp: Date.now(),
        chain: 'Base',
        mode: 'dryrun',
        category: 'reverted_on_chain',
        category_confidence: 1,
        payload: {},
      }),
    ).not.toThrow();
  });

  it('generateFailureId produz IDs únicos + sortable', () => {
    const id1 = generateFailureId(1000);
    const id2 = generateFailureId(2000);
    expect(id1).not.toBe(id2);
    expect(id1 < id2).toBe(true);
  });
});
