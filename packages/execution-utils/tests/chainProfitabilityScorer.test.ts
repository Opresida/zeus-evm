/**
 * Smoke test do ChainProfitabilityScorer (Doutrina 2026-05-27).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ChainProfitabilityScorer,
  formatScoreRankingMarkdown,
  SCORE_WEIGHTS,
} from '../src/scoring';

function mkReconciler(stats: {
  totalReconciliations: number;
  withinNormalBandCount: number;
  realizedTotalUsd: number;
}) {
  return {
    stats: vi.fn().mockReturnValue({
      windowMs: 24 * 3600 * 1000,
      ...stats,
      expectedTotalUsd: 0,
      netDeltaUsd: 0,
      avgDriftBps: 0,
      attributionDistribution: {},
    }),
  } as any;
}

function mkRegistry(totalProfiles: number) {
  return {
    stats: vi.fn().mockReturnValue({
      total_profiles: totalProfiles,
      by_category: {},
      top_threats_top10: [],
    }),
  } as any;
}

describe('ChainProfitabilityScorer — Doutrina 2026-05-27', () => {
  it('pesos da fórmula somam 1 (sem a subtração de competição)', () => {
    const positiveSum =
      SCORE_WEIGHTS.opportunity_density
      + SCORE_WEIGHTS.expected_win_rate
      + SCORE_WEIGHTS.net_profitability;
    expect(positiveSum + SCORE_WEIGHTS.competition_intensity).toBeCloseTo(1.0, 5);
  });

  it('observe acumula observações', () => {
    const scorer = new ChainProfitabilityScorer();
    for (let i = 0; i < 10; i++) {
      scorer.observe({ chain: 'base', protocol: 'morpho' });
    }
    expect(scorer.stats().combos_tracked).toBe(1);
    expect(scorer.stats().total_observations).toBe(10);
  });

  it('scoreFor retorna null com < 5 observações', () => {
    const scorer = new ChainProfitabilityScorer();
    scorer.observe({ chain: 'base', protocol: 'morpho', opportunities_seen: 3 });
    expect(scorer.scoreFor('base', 'morpho')).toBeNull();
  });

  it('score combina componentes corretamente (cenário ideal)', () => {
    const reconciler = mkReconciler({
      totalReconciliations: 100,
      withinNormalBandCount: 80,        // 80% win rate
      realizedTotalUsd: 5000,           // avg $50/op
    });
    const registry = mkRegistry(5);     // pouca competição

    const scorer = new ChainProfitabilityScorer({
      pnlReconciler: reconciler,
      senderRegistry: registry,
    });
    // Saturar opportunity_density com bastante volume
    for (let i = 0; i < 100; i++) {
      scorer.observe({ chain: 'base', protocol: 'morpho' });
    }

    const s = scorer.scoreFor('base', 'morpho')!;
    expect(s.components.expected_win_rate).toBeCloseTo(0.8, 2);
    expect(s.components.net_profitability).toBe(1.0); // $50 = saturação
    expect(s.components.competition_intensity).toBeCloseTo(0.1, 2); // 5/50
    expect(s.score).toBeGreaterThan(0.5);
  });

  it('score baixo quando alta competição + baixo win rate', () => {
    const reconciler = mkReconciler({
      totalReconciliations: 100,
      withinNormalBandCount: 10,        // 10% win rate
      realizedTotalUsd: 500,            // avg $5/op
    });
    const registry = mkRegistry(80);    // muita competição

    const scorer = new ChainProfitabilityScorer({
      pnlReconciler: reconciler,
      senderRegistry: registry,
    });
    for (let i = 0; i < 20; i++) {
      scorer.observe({ chain: 'base', protocol: 'aave-v3-mainstream' });
    }

    const s = scorer.scoreFor('base', 'aave-v3-mainstream')!;
    expect(s.components.expected_win_rate).toBeCloseTo(0.1, 2);
    expect(s.components.competition_intensity).toBe(1.0); // 80 > 50 → cap
    expect(s.score).toBeLessThan(0.3);
  });

  it('rankAll ordena por score desc', () => {
    const reconciler = mkReconciler({
      totalReconciliations: 50,
      withinNormalBandCount: 25,
      realizedTotalUsd: 1000,
    });
    const registry = mkRegistry(10);

    const scorer = new ChainProfitabilityScorer({
      pnlReconciler: reconciler,
      senderRegistry: registry,
    });

    // 3 combos com volumes diferentes (varia opportunity_density)
    for (let i = 0; i < 50; i++) scorer.observe({ chain: 'base', protocol: 'morpho' });
    for (let i = 0; i < 20; i++) scorer.observe({ chain: 'base', protocol: 'aave-v3' });
    for (let i = 0; i < 5; i++) scorer.observe({ chain: 'arb', protocol: 'compound-v3' });

    const ranking = scorer.rankAll();
    expect(ranking.length).toBe(3);
    expect(ranking[0]!.score).toBeGreaterThanOrEqual(ranking[1]!.score);
    expect(ranking[1]!.score).toBeGreaterThanOrEqual(ranking[2]!.score);
  });

  it('markdown formatter inclui medalhas + recomendação se top >= 0.6', () => {
    const reconciler = mkReconciler({
      totalReconciliations: 100,
      withinNormalBandCount: 90,
      realizedTotalUsd: 5000,
    });
    const registry = mkRegistry(3);

    const scorer = new ChainProfitabilityScorer({
      pnlReconciler: reconciler,
      senderRegistry: registry,
    });
    // Saturar density (1700 ops em 7d = ~10 ops/h)
    for (let i = 0; i < 1700; i++) scorer.observe({ chain: 'base', protocol: 'morpho' });

    const md = formatScoreRankingMarkdown(scorer.rankAll());
    expect(md).toContain('🥇');
    expect(md).toContain('base × morpho');
    expect(md).toContain('Recomendação');
  });

  it('markdown vazio quando sem dados suficientes', () => {
    const scorer = new ChainProfitabilityScorer();
    const md = formatScoreRankingMarkdown(scorer.rankAll());
    expect(md).toContain('Sem dados suficientes');
  });

  it('observações velhas saem do window automaticamente', () => {
    vi.useFakeTimers();
    const scorer = new ChainProfitabilityScorer({ windowMs: 1000 });
    for (let i = 0; i < 10; i++) scorer.observe({ chain: 'base', protocol: 'morpho' });
    expect(scorer.stats().total_observations).toBe(10);

    vi.advanceTimersByTime(2000);
    scorer.observe({ chain: 'base', protocol: 'morpho' });
    expect(scorer.stats().total_observations).toBe(1);
    vi.useRealTimers();
  });

  it('opportunities_seen permite batch register', () => {
    const scorer = new ChainProfitabilityScorer();
    scorer.observe({ chain: 'base', protocol: 'morpho', opportunities_seen: 25 });
    expect(scorer.stats().total_observations).toBe(25);
  });
});
