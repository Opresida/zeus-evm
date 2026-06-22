/**
 * Fase 5a — PnlReconciler.onReconcile alimenta PnlAggregator + CalibrationDriftTracker.
 * Valida o fan-out desacoplado + a detecção de drift sustentado.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PnlReconciler } from '../src/pnl/pnlReconciler';
import { PnlAggregator } from '../src/pnl/pnlAggregator';
import { CalibrationDriftTracker } from '../src/analytics/calibrationDriftTracker';

function freshDir(): string {
  return join(tmpdir(), `zeus-pnlobs-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
}

describe('PnlReconciler onReconcile → aggregator + drift (Fase 5a)', () => {
  let baseDir: string;
  let aggregator: PnlAggregator;
  let drift: CalibrationDriftTracker;
  let reconciler: PnlReconciler;

  beforeEach(() => {
    baseDir = freshDir();
    aggregator = new PnlAggregator();
    drift = new CalibrationDriftTracker();
    reconciler = new PnlReconciler({
      baseDir,
      onReconcile: (recon) => {
        aggregator.observe(recon);
        drift.observe({
          timestamp: recon.timestamp,
          protocol: recon.protocol,
          pair: recon.context.opportunity_id,
          venue: recon.context.venue,
          hour_utc: new Date(recon.timestamp).getUTCHours(),
          drift_bps: recon.deltas.profit_delta_bps,
          realized_profit_usd: recon.realized.profit_usd,
        });
      },
    });
  });
  afterEach(() => {
    if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  });

  function losingOp(i: number) {
    reconciler.reconcile({
      chain: 'Base', protocol: 'aave-v3', tx_hash: `0x${i}`, block_number: BigInt(i),
      expected_profit_wei: 10n, expected_profit_usd: 10, // esperava $10
      realized_profit_wei: 6n, realized_profit_usd: 6,    // realizou $6 → drift -4000bps
      realized_gas_units_used: 100n, realized_gas_usd: 0.5,
    });
  }

  it('alimenta o aggregator a cada reconcile', () => {
    expect(aggregator.stats().total_samples).toBe(0);
    losingOp(1);
    losingOp(2);
    expect(aggregator.stats().total_samples).toBe(2);
    const byProto = aggregator.aggregate('protocol', '7d');
    expect(byProto[0]!.key).toBe('aave-v3');
    expect(byProto[0]!.net_delta_usd).toBeLessThan(0); // realizou menos que o esperado
  });

  it('detecta drift sustentado após >= 10 ops perdedoras', () => {
    for (let i = 1; i <= 12; i++) losingOp(i);
    const alerts = drift.topAlerts(5);
    expect(alerts.length).toBeGreaterThan(0);
    const proto = alerts.find((a) => a.dimension === 'protocol' && a.key === 'aave-v3');
    expect(proto?.is_sustained_drift).toBe(true);
    expect(proto?.avg_drift_bps).toBeLessThan(-300);
    expect(proto?.suggested_action).toBeTruthy();
  });
});
