/**
 * Smoke test do inclusionCostBreakdown (Item 10 P4).
 */

import { describe, expect, it } from 'vitest';

import {
  computeInclusionCost,
  formatBreakdownLog,
} from '../src/pnl';

describe('inclusionCostBreakdown — Item 10 P4', () => {
  it('decompõe componentes base/priority/l1/bribe', () => {
    const b = computeInclusionCost({
      gasUnitsUsed: 350_000n,
      baseFeePerGas: 50_000_000n,       // 0.05 gwei
      priorityFeePerGas: 100_000_000n,  // 0.1 gwei
      l1FeeWei: 12_000_000_000_000n,    // ~0.000012 ETH
      bribeWei: 500_000_000_000_000n,   // 0.0005 ETH
      ethUsdPrice: 3500,
      realizedProfitUsd: 25,
    });

    expect(b.base_fee_wei).toBe(50_000_000n * 350_000n);
    expect(b.priority_fee_wei).toBe(100_000_000n * 350_000n);
    expect(b.base_fee_usd).toBeGreaterThan(0);
    expect(b.priority_fee_usd).toBeGreaterThan(b.base_fee_usd); // priority é 2x base
    expect(b.l1_data_fee_usd).toBeCloseTo(0.042, 2);
    expect(b.bribe_usd).toBeCloseTo(1.75, 2);
    expect(b.dominant_component).toBe('bribe');
    expect(b.inclusion_as_percent_of_profit).toBeCloseTo(b.total_inclusion_usd / 25, 4);
  });

  it('total_inclusion exclui base fee (queimado)', () => {
    const b = computeInclusionCost({
      gasUnitsUsed: 100_000n,
      baseFeePerGas: 1_000_000_000n, // 1 gwei base
      priorityFeePerGas: 1_000_000_000n,
      ethUsdPrice: 3500,
    });
    expect(b.total_cost_usd).toBeCloseTo(b.base_fee_usd + b.priority_fee_usd, 6);
    expect(b.total_inclusion_usd).toBeCloseTo(b.priority_fee_usd, 6);
  });

  it('dominant_component identifica maior componente', () => {
    const bribeHeavy = computeInclusionCost({
      gasUnitsUsed: 100_000n,
      baseFeePerGas: 1_000_000n,
      priorityFeePerGas: 1_000_000n,
      bribeWei: 1_000_000_000_000_000n, // 0.001 ETH bribe
      ethUsdPrice: 3500,
    });
    expect(bribeHeavy.dominant_component).toBe('bribe');

    const l1Heavy = computeInclusionCost({
      gasUnitsUsed: 100_000n,
      baseFeePerGas: 1_000_000n,
      priorityFeePerGas: 1_000_000n,
      l1FeeWei: 2_000_000_000_000_000n, // 0.002 ETH L1 cost
      ethUsdPrice: 3500,
    });
    expect(l1Heavy.dominant_component).toBe('l1_data_fee');
  });

  it('inclusion_as_percent_of_profit é 0 quando profit não informado', () => {
    const b = computeInclusionCost({
      gasUnitsUsed: 100_000n,
      baseFeePerGas: 1_000_000_000n,
      priorityFeePerGas: 1_000_000_000n,
      ethUsdPrice: 3500,
    });
    expect(b.inclusion_as_percent_of_profit).toBe(0);
  });

  it('formatBreakdownLog gera string legível', () => {
    const b = computeInclusionCost({
      gasUnitsUsed: 100_000n,
      baseFeePerGas: 1_000_000_000n,
      priorityFeePerGas: 1_000_000_000n,
      bribeWei: 100_000_000_000_000n,
      ethUsdPrice: 3500,
      realizedProfitUsd: 10,
    });
    const s = formatBreakdownLog(b);
    expect(s).toContain('base=$');
    expect(s).toContain('prio=$');
    expect(s).toContain('bribe=$');
    expect(s).toContain('dom=');
    expect(s).toContain('pct_of_profit=');
  });
});
