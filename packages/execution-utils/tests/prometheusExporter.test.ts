/**
 * Smoke test do MetricRegistry (Item 16B OB2).
 */

import { describe, expect, it } from 'vitest';

import {
  MetricRegistry,
  STANDARD_METRICS,
  registerStandardMetrics,
} from '../src/observability';

describe('MetricRegistry — Item 16B OB2', () => {
  it('define + inc counter funciona', () => {
    const r = new MetricRegistry();
    r.define({ name: 'test_counter', help: 'Test', type: 'counter' });
    r.inc('test_counter', { chain: 'Base' });
    r.inc('test_counter', { chain: 'Base' });
    r.inc('test_counter', { chain: 'Arbitrum' });

    const output = r.render();
    expect(output).toContain('test_counter{chain="Base"} 2');
    expect(output).toContain('test_counter{chain="Arbitrum"} 1');
  });

  it('define + set gauge funciona', () => {
    const r = new MetricRegistry();
    r.define({ name: 'test_gauge', help: 'Test', type: 'gauge' });
    r.set('test_gauge', 42.5, { service: 'liquidator' });
    r.set('test_gauge', 50, { service: 'liquidator' }); // substitui

    const output = r.render();
    expect(output).toContain('test_gauge{service="liquidator"} 50');
    expect(output).not.toContain('42.5');
  });

  it('observe histogram registra buckets + sum + count', () => {
    const r = new MetricRegistry();
    r.define({ name: 'test_hist', help: 'Test', type: 'histogram' });
    r.observe('test_hist', 0.05, { protocol: 'aave-v3' });
    r.observe('test_hist', 0.3, { protocol: 'aave-v3' });
    r.observe('test_hist', 1.5, { protocol: 'aave-v3' });

    const output = r.render();
    expect(output).toContain('test_hist_bucket');
    expect(output).toContain('test_hist_sum{protocol="aave-v3"} 1.85');
    expect(output).toContain('test_hist_count{protocol="aave-v3"} 3');
    expect(output).toContain('le="+Inf"');
  });

  it('render produz HELP + TYPE pra cada métrica', () => {
    const r = new MetricRegistry();
    r.define({ name: 'foo', help: 'Foo description', type: 'counter' });
    r.inc('foo');

    const output = r.render();
    expect(output).toContain('# HELP foo Foo description');
    expect(output).toContain('# TYPE foo counter');
  });

  it('inc em counter undefined é silencioso (não throw)', () => {
    const r = new MetricRegistry();
    expect(() => r.inc('undefined_counter')).not.toThrow();
  });

  it('escape de label values', () => {
    const r = new MetricRegistry();
    r.define({ name: 'test', help: 'Test', type: 'gauge' });
    r.set('test', 1, { url: 'http://x.com/"weird"' });

    const output = r.render();
    expect(output).toContain('\\"weird\\"');
  });

  it('registerStandardMetrics popula registry', () => {
    const r = new MetricRegistry();
    registerStandardMetrics(r);

    expect(r.stats().definitions).toBe(STANDARD_METRICS.length);
    expect(r.stats().counters).toBeGreaterThan(0);
    expect(r.stats().gauges).toBeGreaterThan(0);
    expect(r.stats().histograms).toBeGreaterThan(0);
  });

  it('uso real — métricas ZEUS funcionam', () => {
    const r = new MetricRegistry();
    registerStandardMetrics(r);

    r.inc('zeus_operations_total', { chain: 'Base', protocol: 'aave-v3', outcome: 'confirmed' });
    r.set('zeus_pnl_realized_usd_total', 234.56, { chain: 'Base', protocol: 'aave-v3' });
    r.observe('zeus_dispatch_duration_seconds', 0.45, { chain: 'Base', protocol: 'aave-v3' });

    const output = r.render();
    expect(output).toContain('zeus_operations_total{chain="Base",outcome="confirmed",protocol="aave-v3"} 1');
    expect(output).toContain('zeus_pnl_realized_usd_total{chain="Base",protocol="aave-v3"} 234.56');
    expect(output).toContain('zeus_dispatch_duration_seconds_count');
  });

  it('reset limpa todos valores mas mantém definitions', () => {
    const r = new MetricRegistry();
    r.define({ name: 'foo', help: 'F', type: 'counter' });
    r.inc('foo');
    r.reset();
    expect(r.stats().definitions).toBe(1);
    // Re-incrementa funciona
    r.inc('foo');
    expect(r.render()).toContain('foo 1');
  });
});
