/**
 * Smoke test do PnlReporter (Item 10 P7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PnlReconciler, buildDigest, formatMarkdown } from '../src/pnl';

function freshDir(): string {
  return join(
    tmpdir(),
    `zeus-reporter-test-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  );
}

describe('PnlReporter — Item 10 P7', () => {
  let baseDir: string;
  let reconciler: PnlReconciler;

  beforeEach(() => {
    baseDir = freshDir();
    reconciler = new PnlReconciler({ baseDir });
  });

  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  });

  it('buildDigest com 0 reconciliations retorna structure válida', () => {
    const digest = buildDigest(reconciler);
    expect(digest.total_recons).toBe(0);
    expect(digest.attribution_breakdown).toHaveLength(0);
    expect(digest.suggestions).toHaveLength(0);
  });

  it('buildDigest agrupa por attribution cause', () => {
    // 3 ops normal_band, 2 com pool_slippage
    for (let i = 0; i < 3; i++) {
      reconciler.reconcile({
        chain: 'Base',
        protocol: 'aave-v3',
        tx_hash: `0x${i}`,
        block_number: BigInt(100 + i),
        expected_profit_wei: 10000n,
        expected_profit_usd: 10,
        realized_profit_wei: 10000n,
        realized_profit_usd: 10,
        realized_gas_units_used: 200000n,
        realized_gas_usd: 0.5,
      });
    }
    for (let i = 0; i < 2; i++) {
      reconciler.reconcile({
        chain: 'Base',
        protocol: 'aave-v3',
        tx_hash: `0xSlip${i}`,
        block_number: BigInt(200 + i),
        expected_profit_wei: 10000n,
        expected_profit_usd: 10,
        expected_swap_output_wei: 1_000_000n,
        expected_slippage_bps: 50,
        realized_profit_wei: 7000n,
        realized_profit_usd: 7,
        realized_swap_output_wei: 950_000n, // 5% slippage
        realized_gas_units_used: 200000n,
        realized_gas_usd: 0.5,
      });
    }

    const digest = buildDigest(reconciler);
    expect(digest.total_recons).toBe(5);

    const normalEntry = digest.attribution_breakdown.find((b) => b.cause === 'within_normal_band');
    const slipEntry = digest.attribution_breakdown.find((b) => b.cause === 'pool_slippage');
    expect(normalEntry?.count).toBe(3);
    expect(slipEntry?.count).toBe(2);
    expect(slipEntry?.lost_usd).toBeGreaterThan(0);
  });

  it('formatMarkdown produz texto legível', () => {
    reconciler.reconcile({
      chain: 'Base',
      protocol: 'aave-v3',
      tx_hash: '0xabc',
      block_number: 100n,
      expected_profit_wei: 10000n,
      expected_profit_usd: 10,
      realized_profit_wei: 9950n,
      realized_profit_usd: 9.95, // -0.5% = within_normal_band
      realized_gas_units_used: 200000n,
      realized_gas_usd: 0.5,
    });

    const digest = buildDigest(reconciler);
    const md = formatMarkdown(digest);

    expect(md).toContain('ZEUS Daily Reconciliation');
    expect(md).toContain('Total Txs Confirmed:');
    expect(md).toContain('Net P&L Realized');
    expect(md).toContain('Attribution Causes');
  });

  it('formatMarkdown com zero recons fala "sem operações"', () => {
    const digest = buildDigest(reconciler);
    const md = formatMarkdown(digest);
    expect(md).toContain('No reconciliations');
  });

  it('suggestions agrupa por causa + soma losses', () => {
    // 3 pool_slippage no mesmo venue
    for (let i = 0; i < 3; i++) {
      reconciler.reconcile({
        chain: 'Base',
        protocol: 'aave-v3',
        tx_hash: `0x${i}`,
        block_number: BigInt(100 + i),
        expected_profit_wei: 10000n,
        expected_profit_usd: 10,
        expected_swap_output_wei: 1_000_000n,
        expected_slippage_bps: 50,
        realized_profit_wei: 5000n,
        realized_profit_usd: 5,
        realized_swap_output_wei: 920_000n, // 8% slippage
        realized_gas_units_used: 200000n,
        realized_gas_usd: 0.5,
        venue: 'uniswapV3-500',
      });
    }

    const digest = buildDigest(reconciler);
    expect(digest.suggestions.length).toBeGreaterThan(0);
    const slipSuggestion = digest.suggestions.find((s) => s.includes('pool_slippage'));
    expect(slipSuggestion).toBeDefined();
    expect(slipSuggestion).toContain('uniswapV3-500');
  });

  it('best_protocol identifica protocol com drift mais positivo', () => {
    // Aave drift positivo
    for (let i = 0; i < 5; i++) {
      reconciler.reconcile({
        chain: 'Base',
        protocol: 'aave-v3',
        tx_hash: `0xA${i}`,
        block_number: BigInt(100 + i),
        expected_profit_wei: 10000n,
        expected_profit_usd: 10,
        realized_profit_wei: 11000n, // +10%
        realized_profit_usd: 11,
        realized_gas_units_used: 200000n,
        realized_gas_usd: 0.5,
      });
    }
    // Compound drift negativo
    for (let i = 0; i < 5; i++) {
      reconciler.reconcile({
        chain: 'Base',
        protocol: 'compound-v3',
        tx_hash: `0xC${i}`,
        block_number: BigInt(200 + i),
        expected_profit_wei: 10000n,
        expected_profit_usd: 10,
        realized_profit_wei: 8000n, // -20%
        realized_profit_usd: 8,
        realized_gas_units_used: 200000n,
        realized_gas_usd: 0.5,
      });
    }

    const digest = buildDigest(reconciler);
    expect(digest.best_protocol?.protocol).toBe('aave-v3');
    expect(digest.worst_protocol?.protocol).toBe('compound-v3');
  });
});
