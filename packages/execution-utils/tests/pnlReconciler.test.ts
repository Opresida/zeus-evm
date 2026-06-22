/**
 * Smoke test do PnlReconciler + attributionAnalyzer (Item 10 P1+P5).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PnlReconciler,
  attribute,
  suggestAction,
  calculateSlippageBps,
} from '../src/pnl';

function freshDir(): string {
  return join(
    tmpdir(),
    `zeus-pnl-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
}

describe('PnlReconciler — Item 10 P1', () => {
  let baseDir: string;
  let reconciler: PnlReconciler;

  beforeEach(() => {
    baseDir = freshDir();
    reconciler = new PnlReconciler({ baseDir });
  });

  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  });

  it('reconcile dentro da banda normal → within_normal_band', () => {
    const recon = reconciler.reconcile({
      chain: 'Base',
      protocol: 'aave-v3',
      tx_hash: '0xabc',
      block_number: 100n,
      expected_profit_wei: 10000n,
      expected_profit_usd: 10.0,
      expected_gas_usd: 0.5,
      realized_profit_wei: 9900n,
      realized_profit_usd: 9.95, // -0.5% delta
      realized_gas_units_used: 200000n,
      realized_gas_usd: 0.48,
    });

    expect(recon.deltas.profit_delta_bps).toBeLessThan(100);
    expect(recon.attribution.primary_cause).toBe('within_normal_band');
    expect(recon.attribution.confidence).toBeGreaterThan(0.9);
  });

  it('reconcile com slippage real alto → pool_slippage', () => {
    const recon = reconciler.reconcile({
      chain: 'Base',
      protocol: 'aave-v3',
      tx_hash: '0xabc',
      block_number: 100n,
      expected_profit_wei: 10000n,
      expected_profit_usd: 10.0,
      expected_swap_output_wei: 1_000_000n,
      expected_slippage_bps: 50, // 0.5% esperado
      realized_profit_wei: 8500n,
      realized_profit_usd: 8.5,
      realized_swap_output_wei: 970_000n, // 3% real = 300bps
      realized_gas_units_used: 200000n,
      realized_gas_usd: 0.5,
    });

    expect(recon.realized.slippage_bps).toBeGreaterThan(200);
    expect(recon.attribution.primary_cause).toBe('pool_slippage');
    expect(recon.attribution.automatable).toBe(true);
  });

  it('reconcile com gas usado >> estimado → gas_spike', () => {
    const recon = reconciler.reconcile({
      chain: 'Base',
      protocol: 'aave-v3',
      tx_hash: '0xabc',
      block_number: 100n,
      expected_profit_wei: 10000n,
      expected_profit_usd: 10.0,
      expected_gas_usd: 0.5,
      realized_profit_wei: 7000n, // -30% drift profit
      realized_profit_usd: 7.0,
      realized_gas_units_used: 500000n,
      realized_gas_usd: 1.5, // 200% acima do estimado
    });

    expect(recon.attribution.primary_cause).toBe('gas_spike');
    expect(recon.attribution.automatable).toBe(true);
  });

  it('reconcile com competitor conhecido → frontrun_loss', () => {
    const recon = reconciler.reconcile({
      chain: 'Base',
      protocol: 'aave-v3',
      tx_hash: '0xabc',
      block_number: 100n,
      expected_profit_wei: 10000n,
      expected_profit_usd: 10.0,
      realized_profit_wei: 5000n, // -50% drift
      realized_profit_usd: 5.0,
      realized_gas_units_used: 200000n,
      realized_gas_usd: 0.5,
      competitor_winner_sender: '0xWintermute123',
    });

    expect(recon.attribution.primary_cause).toBe('frontrun_loss');
    expect(recon.attribution.root_cause_details).toContain('0xWintermu');
  });

  it('persiste JSONL no path diário', () => {
    reconciler.reconcile({
      chain: 'Base',
      protocol: 'aave-v3',
      tx_hash: '0xabc',
      block_number: 100n,
      expected_profit_wei: 10000n,
      expected_profit_usd: 10.0,
      realized_profit_wei: 10000n,
      realized_profit_usd: 10.0,
      realized_gas_units_used: 200000n,
      realized_gas_usd: 0.5,
    });

    const files = readdirSync(baseDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const content = readFileSync(join(baseDir, files[0]!), 'utf-8');
    expect(content).toContain('0xabc');
    expect(content).toContain('within_normal_band');
  });

  it('stats rolling agrega corretamente', () => {
    // 3 ops dentro da banda + 1 com slippage alto
    for (let i = 0; i < 3; i++) {
      reconciler.reconcile({
        chain: 'Base',
        protocol: 'aave-v3',
        tx_hash: `0x${i}`,
        block_number: 100n,
        expected_profit_wei: 10000n,
        expected_profit_usd: 10.0,
        realized_profit_wei: 10000n,
        realized_profit_usd: 10.0,
        realized_gas_units_used: 200000n,
        realized_gas_usd: 0.5,
      });
    }
    reconciler.reconcile({
      chain: 'Base',
      protocol: 'aave-v3',
      tx_hash: '0xX',
      block_number: 101n,
      expected_profit_wei: 10000n,
      expected_profit_usd: 10.0,
      expected_swap_output_wei: 1_000_000n,
      expected_slippage_bps: 50,
      realized_profit_wei: 7000n,
      realized_profit_usd: 7.0,
      realized_swap_output_wei: 950_000n, // 5% slippage
      realized_gas_units_used: 200000n,
      realized_gas_usd: 0.5,
    });

    const stats = reconciler.stats();
    expect(stats.totalReconciliations).toBe(4);
    expect(stats.withinNormalBandCount).toBe(3);
    expect(stats.attributionDistribution.within_normal_band).toBe(3);
    expect(stats.attributionDistribution.pool_slippage).toBe(1);
    expect(stats.expectedTotalUsd).toBeCloseTo(40);
    expect(stats.realizedTotalUsd).toBeCloseTo(37);
    expect(stats.netDeltaUsd).toBeCloseTo(-3);
  });

  it('cumulativeGasUsdPaid acumula gás de todas as reconciliações (Fase 3)', () => {
    expect(reconciler.cumulativeGasUsdPaid()).toBe(0);
    const base = {
      chain: 'Base', protocol: 'aave-v3' as const, tx_hash: '0xg', block_number: 1n,
      expected_profit_wei: 1n, expected_profit_usd: 1, realized_profit_wei: 1n, realized_profit_usd: 1,
      realized_gas_units_used: 100n,
    };
    reconciler.reconcile({ ...base, realized_gas_usd: 0.5 });
    reconciler.reconcile({ ...base, realized_gas_usd: 1.25 });
    expect(reconciler.cumulativeGasUsdPaid()).toBeCloseTo(1.75, 5);
  });
});

describe('attributionAnalyzer (standalone)', () => {
  it('suggestAction retorna texto pra causa automatable', () => {
    const result = attribute({
      expected: { profit_wei: 100n, profit_usd: 10, slippage_bps: 50, net_profit_usd_estimated: 9.5 },
      realized: { profit_wei: 50n, profit_usd: 5, slippage_bps: 300, gas_units_used: 100n, gas_usd_actual: 0.5, net_profit_usd: 4.5 },
      deltas: { profit_delta_bps: -5000, profit_delta_usd: -5, slippage_delta_bps: 250, gas_delta_usd: 0, net_delta_usd: -5 },
      inclusion_cost: { total_inclusion_usd: 0, inclusion_as_percent_of_profit: 0 },
      context: {},
    });

    expect(result.primary_cause).toBe('pool_slippage');
    expect(result.automatable).toBe(true);

    const suggestion = suggestAction(result, {
      // minimal recon pra suggestAction
      realized: { slippage_bps: 300 },
    } as any);
    expect(suggestion).toContain('venue/fee tier');
  });

  it('suggestAction retorna null pra causas não-automatable', () => {
    const result = attribute({
      expected: { profit_wei: 100n, profit_usd: 10, net_profit_usd_estimated: 9.5 },
      realized: { profit_wei: 99n, profit_usd: 9.95, gas_units_used: 100n, gas_usd_actual: 0.5, net_profit_usd: 9.45 },
      deltas: { profit_delta_bps: -50, profit_delta_usd: -0.05, gas_delta_usd: 0, net_delta_usd: -0.05 },
      inclusion_cost: { total_inclusion_usd: 0, inclusion_as_percent_of_profit: 0 },
      context: {},
    });

    expect(result.primary_cause).toBe('within_normal_band');
    const suggestion = suggestAction(result, {} as any);
    expect(suggestion).toBeNull();
  });
});

describe('slippage math', () => {
  it('calculateSlippageBps básico', () => {
    expect(calculateSlippageBps(1000n, 950n)).toBe(500); // 5%
    expect(calculateSlippageBps(1000n, 990n)).toBe(100); // 1%
    expect(calculateSlippageBps(1000n, 1000n)).toBe(0);
    expect(calculateSlippageBps(1000n, 1100n)).toBe(0); // recebeu mais — sem slippage
    expect(calculateSlippageBps(0n, 100n)).toBe(0); // defensivo
  });
});
