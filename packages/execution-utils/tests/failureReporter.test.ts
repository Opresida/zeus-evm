/**
 * Smoke test do FailureReporter (Item 4 A8).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FailureCollector,
  buildFailureDigest,
  formatFailureMarkdown,
  generateFailureId,
  type FailureEvent,
} from '../src/analytics';

function freshDir(): string {
  return join(
    tmpdir(),
    `zeus-failure-reporter-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
}

function mkEvent(over: Partial<FailureEvent> = {}): FailureEvent {
  const ts = over.timestamp ?? Date.now();
  return {
    id: generateFailureId(ts),
    timestamp: ts,
    chain: 'Base',
    mode: 'dryrun',
    protocol: 'aave-v3',
    category: 'reverted_on_chain',
    category_confidence: 0.9,
    our_gas_usd_lost: 0.5,
    expected_profit_usd: 10,
    ...over,
  };
}

describe('FailureReporter — Item 4 A8', () => {
  let baseDir: string;
  let collector: FailureCollector;

  beforeEach(() => {
    baseDir = freshDir();
    collector = new FailureCollector({ baseDir });
  });

  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  });

  it('digest vazio quando não há failures', () => {
    const digest = buildFailureDigest(collector);
    expect(digest.total_failures).toBe(0);
    expect(digest.total_gas_usd_lost).toBe(0);
    expect(digest.by_category).toEqual([]);
    const md = formatFailureMarkdown(digest);
    expect(md).toContain('Nenhuma failure rastreada');
  });

  it('agrega por categoria e protocolo', () => {
    collector.record(mkEvent({ category: 'reverted_on_chain', our_gas_usd_lost: 1, expected_profit_usd: 20 }));
    collector.record(mkEvent({ category: 'reverted_on_chain', our_gas_usd_lost: 2, expected_profit_usd: 30 }));
    collector.record(mkEvent({ category: 'lost_race', protocol: 'compound-v3', our_gas_usd_lost: 0.5, expected_profit_usd: 5 }));

    const digest = buildFailureDigest(collector);

    expect(digest.total_failures).toBe(3);
    expect(digest.total_gas_usd_lost).toBeCloseTo(3.5, 2);
    expect(digest.total_expected_profit_lost_usd).toBeCloseTo(55, 2);

    const revertCat = digest.by_category.find((c) => c.category === 'reverted_on_chain');
    expect(revertCat?.count).toBe(2);
    expect(revertCat?.usd_lost).toBeCloseTo(3, 2);

    const aaveProto = digest.by_protocol.find((p) => p.protocol === 'aave-v3');
    expect(aaveProto?.count).toBe(2);
  });

  it('agrupa top competidores e oportunidades', () => {
    collector.record(mkEvent({
      competitor_winner_sender: '0xCAFEBABECAFEBABECAFEBABECAFEBABECAFEBABE',
      competitor_winner_alias: 'Wintermute',
      opportunity_id: 'opp-1',
      expected_profit_usd: 15,
    }));
    collector.record(mkEvent({
      competitor_winner_sender: '0xCAFEBABECAFEBABECAFEBABECAFEBABECAFEBABE',
      competitor_winner_alias: 'Wintermute',
      opportunity_id: 'opp-1',
      expected_profit_usd: 12,
    }));
    collector.record(mkEvent({
      competitor_winner_sender: '0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF',
      opportunity_id: 'opp-2',
      expected_profit_usd: 8,
    }));

    const digest = buildFailureDigest(collector);

    expect(digest.top_competitors[0]?.wins).toBe(2);
    expect(digest.top_competitors[0]?.alias).toBe('Wintermute');
    expect(digest.top_competitors[0]?.total_taken_usd).toBeCloseTo(27, 2);

    expect(digest.top_lost_opportunities[0]?.opportunity_id).toBe('opp-1');
    expect(digest.top_lost_opportunities[0]?.failures).toBe(2);
  });

  it('formata Markdown com header e seções', () => {
    collector.record(mkEvent({ category: 'gas_outbid', our_gas_usd_lost: 1.23, expected_profit_usd: 10 }));
    const digest = buildFailureDigest(collector);
    const md = formatFailureMarkdown(digest);

    expect(md).toContain('Weekly Failure Digest');
    expect(md).toContain('Total failures:');
    expect(md).toContain('gas_outbid');
    expect(md).toContain('$1.23');
  });
});
