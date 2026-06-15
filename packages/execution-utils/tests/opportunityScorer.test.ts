/**
 * Testes do OpportunityScorer (OIE Fase 4 — ranking universal por EV).
 */

import { describe, expect, it } from 'vitest';

import {
  scoreOpportunity,
  rankOpportunities,
  scoreBackrunOpportunity,
  scoreLiquidationOpportunity,
  oevRecaptureFor,
  GAS_WAR_PRIORS,
  OEV_RECAPTURE_PRIORS,
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

describe('scoreBackrunOpportunity — competitor-aware via gas war', () => {
  it('priors: war é mais competitivo e menos provável que normal', () => {
    expect(GAS_WAR_PRIORS.war.competition).toBeGreaterThan(GAS_WAR_PRIORS.normal.competition);
    expect(GAS_WAR_PRIORS.war.successProbability).toBeLessThan(GAS_WAR_PRIORS.normal.successProbability);
  });

  it('mesma oportunidade vale menos EV em gas war (chance de perder a corrida)', () => {
    const base = { profitUsd: 40, gasUsd: 2, slippageBps: 20 };
    const calmo = scoreBackrunOpportunity({ ...base, gasWarLevel: 'normal' });
    const guerra = scoreBackrunOpportunity({ ...base, gasWarLevel: 'war' });
    // net igual ($38), mas EV ajustado a risco cai com a probabilidade de sucesso
    expect(calmo.netProfitUsd).toBe(38);
    expect(guerra.netProfitUsd).toBe(38);
    expect(guerra.evUsd).toBeLessThan(calmo.evUsd);
    expect(calmo.score).toBeGreaterThan(guerra.score);
  });

  it('default gasWarLevel = normal', () => {
    const semNivel = scoreBackrunOpportunity({ profitUsd: 30, gasUsd: 1 });
    const normal = scoreBackrunOpportunity({ profitUsd: 30, gasUsd: 1, gasWarLevel: 'normal' });
    expect(semNivel.evUsd).toBe(normal.evUsd);
  });

  it('desconta o bribe no EV', () => {
    const semBribe = scoreBackrunOpportunity({ profitUsd: 50, gasUsd: 2, gasWarLevel: 'normal' });
    const comBribe = scoreBackrunOpportunity({ profitUsd: 50, gasUsd: 2, bribeUsd: 20, gasWarLevel: 'normal' });
    expect(comBribe.evUsd).toBeLessThan(semBribe.evUsd);
    expect(comBribe.netProfitUsd).toBe(28); // 50 - 2 - 20
  });
});

describe('scoreLiquidationOpportunity — OEV-aware (prioriza Morpho)', () => {
  it('oevRecaptureFor mapeia protocolos corretamente', () => {
    expect(oevRecaptureFor('morpho-blue')).toBe(0);
    expect(oevRecaptureFor('aave-v3')).toBe(OEV_RECAPTURE_PRIORS.aave);
    expect(oevRecaptureFor('compound-v3')).toBe(OEV_RECAPTURE_PRIORS.compound);
    expect(oevRecaptureFor('moonwell')).toBe(OEV_RECAPTURE_PRIORS.moonwell);
    // fork de Aave (label sem 'aave', ex.: Seamless) → aberto (0)
    expect(oevRecaptureFor('seamless')).toBe(0);
    // desconhecido → 0 (não penaliza)
    expect(oevRecaptureFor('qualquer-coisa')).toBe(0);
  });

  it('mesma liquidação: Morpho domina Aave/Compound/Moonwell pós-OEV', () => {
    const base = { profitUsd: 100, gasUsd: 1, slippageBps: 30 };
    const morpho = scoreLiquidationOpportunity({ ...base, protocol: 'morpho-blue' });
    const aave = scoreLiquidationOpportunity({ ...base, protocol: 'aave-v3' });
    const moonwell = scoreLiquidationOpportunity({ ...base, protocol: 'moonwell' });

    // edge realista pós-OEV: morpho mantém $100, aave ~$15, moonwell ~$1
    expect(morpho.edgeAdjustedProfitUsd).toBe(100);
    expect(aave.edgeAdjustedProfitUsd).toBeCloseTo(15, 1);
    expect(moonwell.edgeAdjustedProfitUsd).toBeCloseTo(1, 1);

    // EV e score ordenam morpho > aave > moonwell
    expect(morpho.evUsd).toBeGreaterThan(aave.evUsd);
    expect(aave.evUsd).toBeGreaterThan(moonwell.evUsd);
    expect(morpho.score).toBeGreaterThan(aave.score);
  });

  it('Moonwell com MEV tax 99%: EV vira quase nada (cai no gate)', () => {
    const moonwell = scoreLiquidationOpportunity({ profitUsd: 50, gasUsd: 1, protocol: 'moonwell' });
    // edge = 50 × 0.01 = $0.50, menos gas $1 → líquido negativo
    expect(moonwell.netProfitUsd).toBeLessThan(0);
    expect(moonwell.evUsd).toBeLessThan(0);
  });

  it('override de recapture permite calibração', () => {
    const s = scoreLiquidationOpportunity({
      profitUsd: 100, gasUsd: 1, protocol: 'aave-v3', oevRecaptureOverride: 0.5,
    });
    expect(s.oevRecapture).toBe(0.5);
    expect(s.edgeAdjustedProfitUsd).toBe(50);
  });
});
