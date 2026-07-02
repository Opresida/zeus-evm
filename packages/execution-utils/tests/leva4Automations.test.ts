/**
 * Leva 4 das automações "vivas" (observe-first) — #10 throttle, #11 revet dinâmico, #12 wallet rebalance.
 */

import { describe, expect, it } from 'vitest';
import { AdaptiveIntervalAdvisor } from '../src/intelligence/adaptiveIntervalAdvisor';
import { computeWalletRebalance } from '../src/intelligence/walletRebalanceAdvisor';
import type { Address } from 'viem';

describe('#10/#11 AdaptiveIntervalAdvisor', () => {
  it('atividade alta → intervalo mínimo (rápido); parado → máximo (lento); histerese', () => {
    const a = new AdaptiveIntervalAdvisor({ baseMs: 2000, minMs: 1000, maxMs: 12000 });
    // Muita atividade → perto do mínimo.
    const busy = a.recommend(1, 'oportunidades ativas');
    expect(busy.recommendedMs).toBeLessThanOrEqual(2000);
    expect(busy.recommendedMs).toBeGreaterThanOrEqual(1000);
    // Parado → perto do máximo (economiza RPC).
    const idle = a.recommend(0, 'sem oportunidade + RPC ocioso');
    expect(idle.recommendedMs).toBeGreaterThan(2000);
    expect(idle.recommendedMs).toBeLessThanOrEqual(12000);
    // Histerese: mudança minúscula não altera a recomendação.
    const prev = a.recommendedMs;
    const tiny = a.recommend(0.02, 'quase igual');
    expect(tiny.recommendedMs).toBe(prev);
    expect(busy.applied).toBe(false); // observe-first
  });
});

describe('#12 computeWalletRebalance', () => {
  it('detecta carteiras abaixo do piso e sugere reabastecer (sem mover nada)', () => {
    const A = '0xaaaa000000000000000000000000000000000001' as Address;
    const B = '0xbbbb000000000000000000000000000000000002' as Address;
    const min = 5_000_000_000_000_000n; // 0.005 ETH piso
    const target = 20_000_000_000_000_000n; // 0.02 ETH alvo
    const balances = new Map<Address, bigint>([
      [A, 1_000_000_000_000_000n], // 0.001 — abaixo do piso
      [B, 30_000_000_000_000_000n], // 0.03 — cheia
    ]);
    const plan = computeWalletRebalance(balances, { minWei: min, targetWei: target });
    expect(plan.senders).toBe(2);
    expect(plan.belowFloor).toBe(1); // só a A
    expect(plan.needsRebalance).toBe(true);
    expect(plan.topUpEth).toBeGreaterThan(0);
    // Pool equilibrado → sem rebalance.
    const ok = computeWalletRebalance(new Map([[A, target], [B, target]]), { minWei: min, targetWei: target });
    expect(ok.needsRebalance).toBe(false);
    expect(ok.summary).toContain('equilibrado');
  });
});
