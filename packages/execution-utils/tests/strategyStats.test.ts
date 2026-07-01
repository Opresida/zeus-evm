import { describe, expect, it } from 'vitest';
import { StrategyStatsTracker } from '../src/strategyStats';

describe('StrategyStatsTracker', () => {
  it('agrega candidatos + executados por estratégia', () => {
    let t = 1_000_000;
    const tr = new StrategyStatsTracker({ now: () => t });
    tr.candidate('classic-liq', 10);
    tr.candidate('classic-liq', 5);
    tr.executed('classic-liq', 9);
    tr.candidate('pre-liq', 20);
    tr.candidate('filler', 2);
    tr.candidate('filler', 3);
    tr.candidate('arb', 12.5); // Fase B — arb cross-DEX (Motor 2) vira estratégia visível
    tr.candidate('arb', 7.5);
    tr.executed('arb', 11);

    const snap = tr.snapshot();
    const by = (s: string) => snap.find((x) => x.strategy === s)!;

    expect(by('arb').candidates24h).toBe(2);
    expect(by('arb').candidateProfitUsd24h).toBe(20);
    expect(by('arb').executed24h).toBe(1);
    expect(by('arb').netUsd24h).toBe(11);

    expect(by('classic-liq').candidates24h).toBe(2);
    expect(by('classic-liq').candidateProfitUsd24h).toBe(15);
    expect(by('classic-liq').executed24h).toBe(1);
    expect(by('classic-liq').netUsd24h).toBe(9);

    expect(by('pre-liq').candidates24h).toBe(1);
    expect(by('pre-liq').candidateProfitUsd24h).toBe(20);
    expect(by('pre-liq').executed24h).toBe(0);

    expect(by('filler').candidates24h).toBe(2);
    expect(by('filler').candidateProfitUsd24h).toBe(5);
  });

  it('sempre retorna as 4 estratégias (mesmo vazias)', () => {
    const snap = new StrategyStatsTracker().snapshot();
    expect(snap.map((s) => s.strategy).sort()).toEqual(['arb', 'classic-liq', 'filler', 'pre-liq']);
    expect(snap.every((s) => s.candidates24h === 0 && s.netUsd24h === 0)).toBe(true);
  });

  it('poda entradas fora da janela rolante', () => {
    let t = 0;
    const tr = new StrategyStatsTracker({ windowMs: 1000, now: () => t });
    tr.candidate('filler', 100); // t=0
    t = 500;
    tr.candidate('filler', 50); // t=500 (dentro)
    t = 1600; // janela = [600, 1600] → a de t=0 e a de t=500 saíram? cutoff=600
    const snap = tr.snapshot();
    const filler = snap.find((s) => s.strategy === 'filler')!;
    expect(filler.candidates24h).toBe(0); // ambas < 600 → podadas
    expect(filler.candidateProfitUsd24h).toBe(0);
  });

  it('ignora valores não-finitos (NaN/Infinity)', () => {
    const tr = new StrategyStatsTracker();
    tr.candidate('pre-liq', NaN);
    tr.executed('pre-liq', Infinity);
    tr.candidate('pre-liq', 7);
    const pre = tr.snapshot().find((s) => s.strategy === 'pre-liq')!;
    expect(pre.candidates24h).toBe(1);
    expect(pre.candidateProfitUsd24h).toBe(7);
    expect(pre.executed24h).toBe(0);
  });
});
