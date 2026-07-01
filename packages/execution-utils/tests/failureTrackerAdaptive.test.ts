/**
 * #4 automação — cooldown ADAPTATIVO (backoff por cooldowns repetidos, observe-first).
 * Prova: sequência ruim alonga a pausa; recuperação encolhe; teto trava; desligado só observa "o que faria".
 */

import { describe, expect, it } from 'vitest';
import { FailureTracker } from '../src/failureTracker';

describe('FailureTracker — cooldown adaptativo (#4)', () => {
  it('observe-first (desligado): aplica a BASE, mas reporta o adaptativo no stats ("o que faria")', () => {
    const t = new FailureTracker({ maxConsecutiveFailures: 1, cooldownDurationMs: 300_000 }); // base 300s
    t.recordFailure('x'); // 1º cooldown → recent=1
    let s = t.stats();
    expect(s.baseCooldownSec).toBe(300);
    expect(s.adaptiveApplied).toBe(false);
    expect(s.adaptiveCooldownSec).toBe(600); // base × (1+1)
    // a pausa REAL segue a base (não injeta) — ~300s
    expect(s.cooldownRemainingMs).toBeGreaterThan(250_000);
    expect(s.cooldownRemainingMs).toBeLessThanOrEqual(300_000);
    t.recordFailure('x'); // recent=2
    expect(t.stats().adaptiveCooldownSec).toBe(900); // base × (1+2)
  });

  it('ligado: injeta o backoff (pausa cresce com cooldowns repetidos)', () => {
    const t = new FailureTracker({ maxConsecutiveFailures: 1, cooldownDurationMs: 300_000, adaptiveCooldownEnabled: true });
    t.recordFailure('x');
    t.recordFailure('x'); // recent=2 → adaptativo 900s
    const s = t.stats();
    expect(s.adaptiveApplied).toBe(true);
    expect(s.cooldownRemainingMs).toBeGreaterThan(800_000); // ~900s injetados
  });

  it('recuperação (sucesso) ENCOLHE o backoff (histerese −1 por sucesso)', () => {
    const t = new FailureTracker({ maxConsecutiveFailures: 1, cooldownDurationMs: 300_000 });
    t.recordFailure('x');
    t.recordFailure('x');
    t.recordFailure('x'); // recent=3 → 1200s
    expect(t.stats().adaptiveCooldownSec).toBe(1200);
    t.recordSuccess(); // recent=2 → 900s
    expect(t.stats().adaptiveCooldownSec).toBe(900);
  });

  it('teto trava o backoff (nunca passa do maxCooldown)', () => {
    const t = new FailureTracker({ maxConsecutiveFailures: 1, cooldownDurationMs: 300_000, maxCooldownMs: 900_000 }); // teto 15min
    for (let i = 0; i < 20; i++) t.recordFailure('x'); // recent=20 → base×21 = 6300s, mas travado em 900
    expect(t.stats().adaptiveCooldownSec).toBe(900);
  });
});
