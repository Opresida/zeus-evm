/**
 * Tests pra CalibrationDriftTracker (Item 4 A4).
 */

import { describe, expect, it } from 'vitest';
import { CalibrationDriftTracker } from '../src/analytics';

describe('CalibrationDriftTracker — Item 4 A4', () => {
  it('observe + byDimension agrupa por protocol', () => {
    const t = new CalibrationDriftTracker({ minSamplesForAlert: 3 });
    for (let i = 0; i < 5; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'aave-v3',
        hour_utc: 14,
        drift_bps: -50,
        realized_profit_usd: 10,
      });
    }
    for (let i = 0; i < 3; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'compound-v3',
        hour_utc: 14,
        drift_bps: 50,
        realized_profit_usd: 5,
      });
    }

    const byProto = t.byDimension('protocol');
    expect(byProto).toHaveLength(2);

    const aave = byProto.find((s) => s.key === 'aave-v3');
    expect(aave?.samples).toBe(5);
    expect(aave?.avg_drift_bps).toBe(-50);
    expect(aave?.is_sustained_drift).toBe(false); // -50 não passa threshold -300

    const compound = byProto.find((s) => s.key === 'compound-v3');
    expect(compound?.samples).toBe(3);
    expect(compound?.avg_drift_bps).toBe(50);
  });

  it('is_sustained_drift dispara quando avg < threshold + samples >= min', () => {
    const t = new CalibrationDriftTracker({
      sustainedDriftThresholdBps: -200,
      minSamplesForAlert: 5,
    });

    // 6 samples com drift -300bps em par BAD
    for (let i = 0; i < 6; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'aave-v3',
        pair: 'WBTC/USDC',
        hour_utc: 14,
        drift_bps: -300,
        realized_profit_usd: 10,
      });
    }
    // 3 samples com drift -300bps em par GOOD (não atinge min)
    for (let i = 0; i < 3; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'aave-v3',
        pair: 'USDC/DAI',
        hour_utc: 14,
        drift_bps: -300,
        realized_profit_usd: 10,
      });
    }

    const byPair = t.byDimension('pair');
    const bad = byPair.find((s) => s.key === 'WBTC/USDC');
    const good = byPair.find((s) => s.key === 'USDC/DAI');

    expect(bad?.is_sustained_drift).toBe(true);
    expect(bad?.suggested_action).toContain('WBTC/USDC');
    expect(good?.is_sustained_drift).toBe(false); // menos de minSamples
  });

  it('topAlerts retorna apenas sustained drifts ordenados', () => {
    const t = new CalibrationDriftTracker({
      sustainedDriftThresholdBps: -100,
      minSamplesForAlert: 3,
    });

    for (let i = 0; i < 5; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'aave-v3',
        hour_utc: 14,
        drift_bps: -500,
        realized_profit_usd: 10,
      });
    }
    for (let i = 0; i < 5; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'compound-v3',
        hour_utc: 14,
        drift_bps: -200,
        realized_profit_usd: 5,
      });
    }

    const alerts = t.topAlerts(10);
    expect(alerts.length).toBeGreaterThan(0);
    // Pior (mais negativo) primeiro
    expect(alerts[0]!.avg_drift_bps).toBeLessThan(alerts[alerts.length - 1]!.avg_drift_bps);
  });

  it('window prune remove amostras antigas', () => {
    const t = new CalibrationDriftTracker({ windowMs: 100 });
    t.observe({
      timestamp: Date.now() - 200, // fora da janela
      protocol: 'aave-v3',
      hour_utc: 14,
      drift_bps: -500,
      realized_profit_usd: 10,
    });
    t.observe({
      timestamp: Date.now(),
      protocol: 'aave-v3',
      hour_utc: 14,
      drift_bps: 100,
      realized_profit_usd: 10,
    });

    const stats = t.stats();
    expect(stats.total_samples).toBe(1); // antiga foi pruned
    expect(stats.avg_drift_bps_all).toBe(100);
  });

  it('hour_utc dimension agrupa por hora', () => {
    const t = new CalibrationDriftTracker({ minSamplesForAlert: 3 });
    for (let i = 0; i < 5; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'aave-v3',
        hour_utc: 14,
        drift_bps: -400,
        realized_profit_usd: 10,
      });
    }
    for (let i = 0; i < 5; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'aave-v3',
        hour_utc: 3,
        drift_bps: -50,
        realized_profit_usd: 10,
      });
    }

    const byHour = t.byDimension('hour_utc');
    expect(byHour).toHaveLength(2);
    const h14 = byHour.find((s) => s.key === '14h');
    expect(h14?.avg_drift_bps).toBe(-400);
  });

  it('venue dimension funciona', () => {
    const t = new CalibrationDriftTracker({ minSamplesForAlert: 3 });
    for (let i = 0; i < 5; i++) {
      t.observe({
        timestamp: Date.now(),
        protocol: 'aave-v3',
        venue: 'uniswapV3-3000',
        hour_utc: 14,
        drift_bps: -400,
        realized_profit_usd: 10,
      });
    }

    const byVenue = t.byDimension('venue');
    expect(byVenue).toHaveLength(1);
    expect(byVenue[0]!.key).toBe('uniswapV3-3000');
    expect(byVenue[0]!.is_sustained_drift).toBe(true);
  });
});
