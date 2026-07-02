/**
 * Leva 5 das automações "vivas" (observe-first) — #13 saúde do flashloan, #14 latência de relay.
 */

import { describe, expect, it } from 'vitest';
import { FlashHealthTracker } from '../src/intelligence/flashHealthTracker';
import { RelayLatencyAdvisor } from '../src/intelligence/relayLatencyAdvisor';

describe('#13 FlashHealthTracker', () => {
  it('mede a distribuição de fontes e avisa quando cai muito no Aave pago', () => {
    let t = 0;
    const fh = new FlashHealthTracker({ now: () => t });
    // Maioria em fontes 0% → saudável.
    for (let i = 0; i < 8; i++) { t += 1000; fh.observe('morpho'); }
    fh.observe('balancer');
    let s = fh.stats();
    expect(s.freeSharePct).toBeGreaterThan(0.9);
    expect(s.degraded).toBe(false);
    expect(s.summary).toContain('saudável');
    // Muitos fallbacks pagos → degradado.
    const fh2 = new FlashHealthTracker({ now: () => t });
    for (let i = 0; i < 6; i++) fh2.observe('aave');
    fh2.observe('morpho');
    s = fh2.stats();
    expect(s.aavePct).toBeGreaterThan(0.25);
    expect(s.degraded).toBe(true);
    expect(s.summary).toContain('PAGO');
  });
});

describe('#14 RelayLatencyAdvisor', () => {
  it('estabelece baseline e avisa quando a latência degrada ≥2×', () => {
    const rl = new RelayLatencyAdvisor();
    expect(rl.status(0, 0).summary).toContain('sem amostra'); // dryrun: sem dispatch
    // Baseline saudável.
    let st = rl.status(100, 50);
    expect(st.baselineP95Ms).toBe(100);
    expect(st.degraded).toBe(false);
    // Latência dobra → degradado.
    st = rl.status(240, 50);
    expect(st.ratio).toBeCloseTo(2.4, 1);
    expect(st.degraded).toBe(true);
    expect(st.summary).toContain('lento');
  });
});
