/**
 * Testes do OpportunityScorer (OIE Fase 4 — ranking universal por EV).
 */

import { describe, expect, it } from 'vitest';

import {
  scoreOpportunity,
  rankOpportunities,
  OPPORTUNITY_WEIGHTS,
} from '../src/scoring';

describe('OpportunityScorer — OIE Fase 4', () => {
  it('pesos positivos + competição somam 1', () => {
    const sum =
      OPPORTUNITY_WEIGHTS.expected_profit
      + OPPORTUNITY_WEIGHTS.success_probability
      + OPPORTUNITY_WEIGHTS.competition
      + OPPORTUNITY_WEIGHTS.slippage;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('evUsd = P(sucesso) × lucro líquido', () => {
    const s = scoreOpportunity({
      expectedProfitUsd: 100,
      gasCostUsd: 10,
      bribeUsd: 5,
      successProbability: 0.8,
    });
    // net = 100 - 10 - 5 = 85; ev = 0.8 * 85 = 68
    expect(s.netProfitUsd).toBe(85);
    expect(s.evUsd).toBe(68);
  });

  it('score sobe com lucro/win-rate e cai com competição/slippage', () => {
    const bom = scoreOpportunity({
      expectedProfitUsd: 60,
      gasCostUsd: 5,
      successProbability: 0.9,
      competitionIntensity: 0.1,
      slippageBps: 10,
    });
    const ruim = scoreOpportunity({
      expectedProfitUsd: 12,
      gasCostUsd: 5,
      successProbability: 0.3,
      competitionIntensity: 0.9,
      slippageBps: 90,
    });
    expect(bom.score).toBeGreaterThan(ruim.score);
    expect(bom.score).toBeGreaterThan(0.5);
    expect(ruim.score).toBeLessThan(0.3);
  });

  it('net_profit normaliza saturando em $50', () => {
    const s = scoreOpportunity({
      expectedProfitUsd: 200,
      gasCostUsd: 0,
      successProbability: 1,
    });
    expect(s.components.expected_profit).toBe(1.0); // > $50 → cap
  });

  it('clampa probabilidade e competição fora de [0,1]', () => {
    const s = scoreOpportunity({
      expectedProfitUsd: 50,
      gasCostUsd: 0,
      successProbability: 1.5,        // clampa → 1
      competitionIntensity: 2,        // clampa → 1
    });
    expect(s.components.success_probability).toBe(1);
    expect(s.components.competition).toBe(1);
  });

  it('lucro líquido negativo → score 0 mas evUsd negativo (não engole prejuízo)', () => {
    const s = scoreOpportunity({
      expectedProfitUsd: 5,
      gasCostUsd: 20,
      successProbability: 0.9,
    });
    expect(s.netProfitUsd).toBe(-15);
    expect(s.evUsd).toBeLessThan(0); // EV negativo é o guard real de decisão
    expect(s.components.expected_profit).toBe(0); // lucro líquido < 0 → componente zera
  });

  it('rankOpportunities ordena por EV desc (a de maior EV vence contenção)', () => {
    type Cand = { id: string; profit: number; p: number };
    const cands: Cand[] = [
      { id: 'a', profit: 30, p: 0.9 }, // ev ~ 0.9*30 = 27
      { id: 'b', profit: 100, p: 0.5 }, // ev ~ 0.5*100 = 50  ← vence
      { id: 'c', profit: 40, p: 0.6 }, // ev ~ 0.6*40 = 24
    ];
    const ranked = rankOpportunities(cands, (c) => ({
      expectedProfitUsd: c.profit,
      gasCostUsd: 0,
      successProbability: c.p,
    }));
    expect(ranked.map((r) => r.item.id)).toEqual(['b', 'a', 'c']);
    expect(ranked[0]!.opportunity.evUsd).toBe(50);
  });
});
