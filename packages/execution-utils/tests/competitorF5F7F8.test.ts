/**
 * Smoke tests dos itens F5 (protocolAffinity), F7 (multiSignalClassifier),
 * F8 (cooccurrenceAnalyzer) do Item 5.
 */

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import {
  computeAffinity,
  topSpecialistsPerProtocol,
  classifyMultiSignal,
  applyClassification,
  CooccurrenceAnalyzer,
  type CompetitorProfile,
} from '../src/competitors';

function mkProfile(over: Partial<CompetitorProfile> = {}): CompetitorProfile {
  return {
    sender: '0x0000000000000000000000000000000000000001' as Address,
    first_seen_at: Date.now() - 86400_000,
    last_seen_at: Date.now(),
    total_txs: 100,
    category: 'unknown',
    category_confidence: 0,
    tags: [],
    gas: {
      samples: 50,
      avg_priority_fee_gwei: 0.1,
      p50_priority_fee_gwei: 0.08,
      p95_priority_fee_gwei: 0.5,
      p99_priority_fee_gwei: 1.0,
    },
    activity: {
      txs_last_24h: 10,
      txs_last_7d: 70,
      txs_last_30d: 100,
      active_hours_utc: [12, 14, 16],
      weekday_distribution: [10, 15, 20, 15, 20, 10, 10],
    },
    protocols: {
      aave_v3: { txs: 0 },
      compound_v3: { txs: 0 },
      morpho_blue: { txs: 0 },
      uniswap_v3: { txs: 0 },
      aerodrome: { txs: 0 },
    },
    threat: { overall_score: 0 },
    ...over,
  };
}

describe('Item 5 F5 — protocolAffinityTracker', () => {
  it('focused: 95% aave-v3 → dominant=aave_v3, specialization=focused', () => {
    const p = mkProfile({
      total_txs: 100,
      protocols: {
        aave_v3: { txs: 95 },
        compound_v3: { txs: 3 },
        morpho_blue: { txs: 2 },
        uniswap_v3: { txs: 0 },
        aerodrome: { txs: 0 },
      },
    });
    const aff = computeAffinity(p);
    expect(aff.dominant_protocol).toBe('aave_v3');
    expect(aff.dominant_share).toBeCloseTo(0.95, 2);
    expect(aff.specialization).toBe('focused');
  });

  it('switching: distribuído entre 4 protocolos → entropy alto', () => {
    const p = mkProfile({
      total_txs: 100,
      protocols: {
        aave_v3: { txs: 30 },
        compound_v3: { txs: 25 },
        morpho_blue: { txs: 20 },
        uniswap_v3: { txs: 15 },
        aerodrome: { txs: 10 },
      },
    });
    const aff = computeAffinity(p);
    expect(aff.active_protocols).toBe(5);
    expect(aff.entropy).toBeGreaterThan(1.5);
    expect(aff.specialization).toBe('switching');
  });

  it('inactive: 0 txs → specialization=inactive', () => {
    const p = mkProfile({ total_txs: 0 });
    const aff = computeAffinity(p);
    expect(aff.specialization).toBe('inactive');
    expect(aff.dominant_protocol).toBeNull();
  });

  it('topSpecialistsPerProtocol ranqueia por share', () => {
    const profiles = [
      mkProfile({
        sender: '0xaaaa000000000000000000000000000000000001' as Address,
        total_txs: 50,
        protocols: {
          aave_v3: { txs: 45 },
          compound_v3: { txs: 5 },
          morpho_blue: { txs: 0 },
          uniswap_v3: { txs: 0 },
          aerodrome: { txs: 0 },
        },
      }),
      mkProfile({
        sender: '0xbbbb000000000000000000000000000000000001' as Address,
        total_txs: 100,
        protocols: {
          aave_v3: { txs: 40 },
          compound_v3: { txs: 60 },
          morpho_blue: { txs: 0 },
          uniswap_v3: { txs: 0 },
          aerodrome: { txs: 0 },
        },
      }),
    ];
    const out = topSpecialistsPerProtocol(profiles);
    expect(out.aave_v3[0]?.share).toBeCloseTo(0.9, 1); // primeiro é 0.9
    expect(out.compound_v3[0]?.share).toBeCloseTo(0.6, 1);
  });
});

describe('Item 5 F7 — multiSignalClassifier', () => {
  it('aave-focused profile → category=liquidator', () => {
    const p = mkProfile({
      total_txs: 100,
      protocols: {
        aave_v3: { txs: 90 },
        compound_v3: { txs: 5 },
        morpho_blue: { txs: 5 },
        uniswap_v3: { txs: 0 },
        aerodrome: { txs: 0 },
      },
    });
    const r = classifyMultiSignal(p);
    expect(r.category).toBe('liquidator');
    expect(r.confidence).toBeGreaterThan(0.4);
    expect(r.tags).toContain('aave_specialist');
  });

  it('high gas premium → mev_searcher', () => {
    const p = mkProfile({
      gas: {
        samples: 50,
        avg_priority_fee_gwei: 5,
        p50_priority_fee_gwei: 4,
        p95_priority_fee_gwei: 10, // 200x o mercado 0.05
        p99_priority_fee_gwei: 20,
      },
      protocols: {
        aave_v3: { txs: 20 },
        compound_v3: { txs: 0 },
        morpho_blue: { txs: 0 },
        uniswap_v3: { txs: 80 },
        aerodrome: { txs: 0 },
      },
      total_txs: 100,
    });
    const r = classifyMultiSignal(p, { market_p50_gas_gwei: 0.05 });
    expect(['mev_searcher', 'generic_arber']).toContain(r.category);
    expect(r.tags).toContain('high_gas_premium');
  });

  it('high revert rate → spammer detection', () => {
    const p = mkProfile({ total_txs: 100 });
    const r = classifyMultiSignal(p, { revert_rate: 0.6 });
    expect(r.candidates.some((c) => c.category === 'spammer')).toBe(true);
    expect(r.tags).toContain('high_revert_rate');
  });

  it('known_alias override determinístico', () => {
    const p = mkProfile({ known_alias: 'Wintermute' });
    const r = classifyMultiSignal(p);
    expect(r.category).toBe('mev_searcher');
    expect(r.confidence).toBeGreaterThan(0.95);
    expect(r.signals_used).toEqual(['known_alias']);
  });

  it('applyClassification muta profile', () => {
    const p = mkProfile({
      total_txs: 100,
      protocols: {
        aave_v3: { txs: 90 },
        compound_v3: { txs: 10 },
        morpho_blue: { txs: 0 },
        uniswap_v3: { txs: 0 },
        aerodrome: { txs: 0 },
      },
    });
    const r = classifyMultiSignal(p);
    applyClassification(p, r);
    expect(p.category).toBe(r.category);
    expect(p.category_confidence).toBe(r.confidence);
  });
});

describe('Item 5 F8 — cooccurrenceAnalyzer', () => {
  const A = '0xaaaa000000000000000000000000000000000001' as Address;
  const B = '0xbbbb000000000000000000000000000000000001' as Address;
  const C = '0xcccc000000000000000000000000000000000001' as Address;

  it('observeBlock incrementa singletons + pairs', () => {
    const an = new CooccurrenceAnalyzer({ minCooccurrences: 1 });
    an.observeBlock(100n, Date.now(), [A, B]);
    an.observeBlock(101n, Date.now(), [A, B]);
    const links = an.topLinks();
    expect(links.length).toBe(1);
    expect(links[0]?.cooccurrences).toBe(2);
    expect(links[0]?.jaccard).toBe(1); // 100% sempre juntos
  });

  it('jaccard reflete partial overlap', () => {
    const an = new CooccurrenceAnalyzer({ minCooccurrences: 1 });
    // A,B juntos 3 blocos; A sozinho 2 blocos extras
    an.observeBlock(1n, Date.now(), [A, B]);
    an.observeBlock(2n, Date.now(), [A, B]);
    an.observeBlock(3n, Date.now(), [A, B]);
    an.observeBlock(4n, Date.now(), [A, C]);
    an.observeBlock(5n, Date.now(), [A]);

    const links = an.topLinks();
    const ab = links.find((l) => [l.sender_a.toLowerCase(), l.sender_b.toLowerCase()].sort().join() === [A.toLowerCase(), B.toLowerCase()].sort().join());
    expect(ab?.cooccurrences).toBe(3);
    expect(ab?.jaccard).toBeCloseTo(3 / (5 + 3 - 3), 2); // 3/5 = 0.6
  });

  it('detectClusters identifica grupos conectados', () => {
    const an = new CooccurrenceAnalyzer({ minCooccurrences: 2, minJaccard: 0.3 });
    // A-B-C todos juntos várias vezes
    for (let i = 0; i < 10; i++) {
      an.observeBlock(BigInt(i + 1), Date.now(), [A, B, C]);
    }
    const clusters = an.detectClusters();
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.members.length).toBe(3);
    expect(clusters[0]?.avg_jaccard).toBe(1);
  });

  it('stats reporta counts corretos', () => {
    const an = new CooccurrenceAnalyzer({ minCooccurrences: 1 });
    an.observeBlock(1n, Date.now(), [A, B]);
    an.observeBlock(2n, Date.now(), [B, C]);
    const s = an.stats();
    expect(s.total_observations).toBe(2);
    expect(s.unique_senders).toBe(3);
    expect(s.total_pairs_tracked).toBe(2);
  });

  it('snapshot devolve stats + clusters serializáveis (Fase 5)', () => {
    const an = new CooccurrenceAnalyzer({ minCooccurrences: 2, minJaccard: 0.3 });
    for (let i = 0; i < 10; i++) an.observeBlock(BigInt(i + 1), Date.now(), [A, B, C]);
    const snap = an.snapshot();
    expect(snap.clusters.length).toBe(1);
    expect(snap.clusters[0]!.members.length).toBe(3);
    expect(snap.stats.unique_senders).toBe(3);
    expect(typeof snap.updatedAt).toBe('number');
    // serializável (sem BigInt solto que quebraria JSON.stringify)
    expect(() => JSON.stringify(snap)).not.toThrow();
  });
});
