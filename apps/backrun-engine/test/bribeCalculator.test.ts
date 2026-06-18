/**
 * Fase 1 — market-bribe no BribeCalculator.
 *
 * Garante:
 *  - sem marketBribeStats → comportamento idêntico ao da tabela fixa (aditivo).
 *  - com marketBribeStats + expectedGasUnits → respeita o PISO de mercado (não brigar abaixo do p75).
 *  - piso de mercado não fura o hard cap / skip de 95% (não sangra o profit).
 */

import { describe, expect, it } from 'vitest';
import type { MarketBribeStats } from '@zeus-evm/execution-utils';
import { BribeCalculator } from '../src/bribe/bribeCalculator';

const ETH_USD = 3000;

function calc(): BribeCalculator {
  return new BribeCalculator({ ethUsdPrice: ETH_USD });
}

function market(p75Gwei: number, competitorsActive = 5): MarketBribeStats {
  return {
    competitorsActive,
    samples: 100,
    avgGwei: p75Gwei * 0.8,
    p50Gwei: p75Gwei * 0.7,
    p75Gwei,
    p95Gwei: p75Gwei * 1.5,
    updatedAt: Date.now(),
  };
}

describe('BribeCalculator — market-bribe (Fase 1)', () => {
  it('sem marketBribeStats: usa a tabela fixa (normal=30%)', () => {
    const d = calc().decide({ expectedNetProfitUsd: 100, gasWarLevel: 'normal' });
    expect(d.skip).toBe(false);
    if (!d.skip) {
      expect(d.bribeUsd).toBeCloseTo(30, 1); // 30% de $100
      expect(d.bribeBpsApplied).toBe(3000);
    }
  });

  it('com piso de mercado MAIOR que a tabela: sobe o bribe pro piso', () => {
    // p75 = 10 gwei, gas = 2M → floor = 10e9 * 2e6 = 2e16 wei = 0.02 ETH = $60 @ $3000.
    const d = calc().decide({
      expectedNetProfitUsd: 100,
      gasWarLevel: 'normal',
      marketBribeStats: market(10),
      expectedGasUnits: 2_000_000n,
    });
    expect(d.skip).toBe(false);
    if (!d.skip) {
      // tabela daria $30; mercado puxa pra ~$60.
      expect(d.bribeUsd).toBeCloseTo(60, 0);
      expect(d.bribeBpsApplied).toBeGreaterThanOrEqual(5900);
      // minBribeWei reflete o piso de mercado (2e16 wei).
      expect(d.bribe.minBribeWei).toBe(20_000_000_000_000_000n);
    }
  });

  it('piso de mercado abaixo da tabela: comportamento inalterado', () => {
    // p75 = 1 gwei, gas = 2M → floor = $6 < $30 da tabela → não muda.
    const d = calc().decide({
      expectedNetProfitUsd: 100,
      gasWarLevel: 'normal',
      marketBribeStats: market(1),
      expectedGasUnits: 2_000_000n,
    });
    expect(d.skip).toBe(false);
    if (!d.skip) expect(d.bribeUsd).toBeCloseTo(30, 1);
  });

  it('piso de mercado absurdo fura o profit → SKIP (não sangra)', () => {
    // p75 = 1000 gwei, gas = 2M → floor = $6000 >> profit $30 → skip.
    const d = calc().decide({
      expectedNetProfitUsd: 30,
      gasWarLevel: 'war',
      marketBribeStats: market(1000),
      expectedGasUnits: 2_000_000n,
    });
    expect(d.skip).toBe(true);
  });

  it('marketBribeStats sem expectedGasUnits: piso ignorado (aditivo seguro)', () => {
    const d = calc().decide({
      expectedNetProfitUsd: 100,
      gasWarLevel: 'normal',
      marketBribeStats: market(10),
      // sem expectedGasUnits
    });
    expect(d.skip).toBe(false);
    if (!d.skip) expect(d.bribeUsd).toBeCloseTo(30, 1);
  });
});
