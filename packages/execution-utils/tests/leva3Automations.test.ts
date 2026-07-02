/**
 * Leva 3 das automações "vivas" (observe-first) — #7 quarentena, #8 pool depth, #9 calibração de gás.
 * Prova: janela rolante + histerese + threshold, sem inventar sinal.
 */

import { describe, expect, it } from 'vitest';
import { GasCalibrationTracker } from '../src/intelligence/gasCalibrationTracker';
import { PoolDepthTracker } from '../src/intelligence/poolDepthTracker';
import { TokenQuarantineTracker } from '../src/intelligence/tokenQuarantineTracker';

describe('#9 GasCalibrationTracker', () => {
  it('observa custo ao vivo, compara com o estático e diz o que ajustaria (com histerese)', () => {
    let t = 0;
    const gc = new GasCalibrationTracker({ configuredUsd: 0.5, now: () => t });
    // Poucas amostras → não recalibra (histerese): mantém o estático.
    gc.observe(0.04);
    expect(gc.stats(true).applied).toBe(false);
    expect(gc.effectiveGasCostUsd(true)).toBe(0.5);
    // Enche a janela com gás real BEM mais barato que o estático (Base é barata).
    for (let i = 0; i < 10; i++) { t += 1000; gc.observe(0.04); }
    const s = gc.stats(true);
    expect(s.samples).toBeGreaterThanOrEqual(5);
    expect(s.observedP95Usd).toBeCloseTo(0.04, 2);
    expect(s.driftPct).toBeLessThan(0); // estático SUPERESTIMA → rejeitaria trades bons
    expect(gc.isDrifting()).toBe(true); // |drift| >> 25%
    // Ligado → usa o observado; desligado → o estático (observe-first).
    expect(gc.effectiveGasCostUsd(true)).toBeCloseTo(0.04, 2);
    expect(gc.effectiveGasCostUsd(false)).toBe(0.5);
  });
});

describe('#8 PoolDepthTracker', () => {
  it('detecta queda de profundidade ≥30% na janela (com histerese de amostras)', () => {
    let t = 0;
    const pd = new PoolDepthTracker({ windowMs: 60_000, now: () => t });
    pd.observe('poolA', 100_000, 'WETH/USDC');
    t += 1000; pd.observe('poolA', 98_000);
    expect(pd.alerts()).toHaveLength(0); // sem queda relevante
    t += 1000; pd.observe('poolA', 60_000); // caiu 40% do pico
    const al = pd.alerts();
    expect(al).toHaveLength(1);
    expect(al[0]!.poolKey).toBe('poolA');
    expect(al[0]!.dropPct).toBeCloseTo(0.4, 1);
    expect(al[0]!.label).toBe('WETH/USDC');
    // Pool saudável não alerta.
    pd.observe('poolB', 50_000); pd.observe('poolB', 50_000); pd.observe('poolB', 51_000);
    expect(pd.alerts().find((a) => a.poolKey === 'poolB')).toBeUndefined();
  });
});

describe('#7 TokenQuarantineTracker', () => {
  it('quarentena só com threshold cheio; sucesso alivia (histerese)', () => {
    let t = 0;
    const q = new TokenQuarantineTracker({ threshold: 3, now: () => t });
    q.recordFailure('0xTok', { symbol: 'BAD', reason: 'reverted' });
    q.recordFailure('0xTok', { reason: 'reverted' });
    expect(q.wouldQuarantine('0xTok')).toBe(false); // 2 < 3
    t += 1000; q.recordFailure('0xtok', { reason: 'lost_race' }); // case-insensitive
    expect(q.wouldQuarantine('0xTok')).toBe(true); // 3 → quarentenaria
    const snap = q.snapshot();
    expect(snap[0]!.symbol).toBe('BAD');
    expect(snap[0]!.failures).toBe(3);
    expect(q.quarantined()).toHaveLength(1);
    // Um sucesso alivia → sai da quarentena.
    q.recordSuccess('0xTok');
    expect(q.wouldQuarantine('0xTok')).toBe(false);
  });
});
