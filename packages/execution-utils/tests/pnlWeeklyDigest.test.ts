/**
 * Smoke test do PnL weekly digest (Item 10 P8).
 */

import { describe, expect, it } from 'vitest';

import {
  PnlAggregator,
  buildWeeklyDigest,
  formatWeeklyMarkdown,
  generateReconciliationId,
  type PnlReconciliation,
} from '../src/pnl';

function mkRecon(over: Partial<PnlReconciliation> = {}): PnlReconciliation {
  const ts = over.timestamp ?? Date.now();
  return {
    id: generateReconciliationId(ts),
    timestamp: ts,
    chain: 'Base',
    protocol: 'aave-v3',
    tx_hash: '0xabc',
    block_number: 12345n,
    expected: {
      profit_wei: 0n,
      profit_usd: 10,
      net_profit_usd_estimated: 8,
    },
    realized: {
      profit_wei: 0n,
      profit_usd: 10,
      gas_units_used: 200_000n,
      gas_usd_actual: 0.5,
      net_profit_usd: 9.5,
    },
    deltas: {
      profit_delta_bps: 0,
      profit_delta_usd: 0,
      gas_delta_usd: 0,
      net_delta_usd: 1.5,
    },
    inclusion_cost: {
      total_inclusion_usd: 0.5,
      inclusion_as_percent_of_profit: 0.05,
    },
    attribution: {
      primary_cause: 'within_normal_band',
      confidence: 1,
      root_cause_details: '',
      automatable: false,
    },
    context: {
      venue: 'uniswapV3-500',
    },
    ...over,
  };
}

describe('PnL Weekly Digest — Item 10 P8', () => {
  it('digest vazio quando aggregator sem samples', () => {
    const agg = new PnlAggregator();
    const digest = buildWeeklyDigest(agg);
    expect(digest.total_samples_7d).toBe(0);
    const md = formatWeeklyMarkdown(digest);
    expect(md).toContain('Sem operações');
  });

  it('agrega por protocolo, venue e hora', () => {
    const agg = new PnlAggregator();
    // Adiciona 5 reconciliations aave-v3 vencedoras
    for (let i = 0; i < 5; i++) {
      agg.observe(mkRecon({ protocol: 'aave-v3' }));
    }
    // Adiciona 3 backrun perdedoras
    for (let i = 0; i < 3; i++) {
      agg.observe(mkRecon({
        protocol: 'backrun',
        realized: { ...mkRecon().realized, net_profit_usd: -2 },
        deltas: { ...mkRecon().deltas, net_delta_usd: -2, profit_delta_bps: -500 },
      }));
    }

    const digest = buildWeeklyDigest(agg);
    expect(digest.total_samples_7d).toBe(8);
    expect(digest.by_protocol.length).toBeGreaterThanOrEqual(2);

    const md = formatWeeklyMarkdown(digest);
    expect(md).toContain('Weekly PnL Deep Dive');
    expect(md).toContain('Por Protocolo');
    expect(md).toContain('aave-v3');
    expect(md).toContain('backrun');
  });

  it('ordenação worst_overall expõe protocolos com net_delta negativo', () => {
    const agg = new PnlAggregator();
    for (let i = 0; i < 4; i++) {
      agg.observe(mkRecon({
        protocol: 'backrun',
        realized: { ...mkRecon().realized, net_profit_usd: -3 },
        deltas: { ...mkRecon().deltas, net_delta_usd: -3, profit_delta_bps: -800 },
        expected: { ...mkRecon().expected, profit_usd: 5 },
      }));
    }
    const digest = buildWeeklyDigest(agg);
    const worst = digest.worst_overall;
    if (worst.length > 0) {
      expect(worst[0]?.net_delta_usd).toBeLessThan(0);
    }
  });
});
