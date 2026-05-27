/**
 * Smoke tests pra peças finais Fase 1:
 *  - CacheInvalidator (Item 9 R3)
 *  - PnlAggregator (Item 10 P6)
 *  - BuilderAttributionTracker (Item 5 F6)
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CacheInvalidator,
  PnlAggregator,
  BuilderAttributionTracker,
  lookupBuilder,
  type PnlReconciliation,
} from '../src';

describe('CacheInvalidator — Item 9 R3', () => {
  it('register + flushAll chama todos callbacks', async () => {
    const inv = new CacheInvalidator();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    inv.register('cache1', fn1);
    inv.register('cache2', fn2);

    await inv.flushAll(100n);
    expect(fn1).toHaveBeenCalledWith(100n);
    expect(fn2).toHaveBeenCalledWith(100n);
    expect(inv.stats().total_invalidations).toBe(1);
  });

  it('erro em 1 cache NÃO interrompe outros', async () => {
    const inv = new CacheInvalidator();
    const fn1 = vi.fn(() => { throw new Error('boom'); });
    const fn2 = vi.fn();
    inv.register('bad', fn1);
    inv.register('good', fn2);

    await inv.flushAll();
    expect(fn2).toHaveBeenCalled();
  });

  it('unregister remove callback', async () => {
    const inv = new CacheInvalidator();
    const fn = vi.fn();
    inv.register('cache', fn);
    expect(inv.unregister('cache')).toBe(true);
    await inv.flushAll();
    expect(fn).not.toHaveBeenCalled();
  });

  it('re-register substitui callback', async () => {
    const inv = new CacheInvalidator();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    inv.register('cache', fn1);
    inv.register('cache', fn2);
    expect(inv.stats().caches_registered).toBe(1);
    await inv.flushAll();
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalled();
  });

  it('callback async é awaited', async () => {
    const inv = new CacheInvalidator();
    let done = false;
    inv.register('async', async () => {
      await new Promise((r) => setTimeout(r, 50));
      done = true;
    });
    await inv.flushAll();
    expect(done).toBe(true);
  });
});

describe('PnlAggregator — Item 10 P6', () => {
  function makeRecon(opts: Partial<PnlReconciliation>): PnlReconciliation {
    return {
      id: opts.id ?? `r-${Math.random()}`,
      timestamp: opts.timestamp ?? Date.now(),
      chain: opts.chain ?? 'Base',
      protocol: opts.protocol ?? 'aave-v3',
      tx_hash: opts.tx_hash ?? '0x',
      block_number: opts.block_number ?? 100n,
      expected: opts.expected ?? {
        profit_wei: 100n,
        profit_usd: 10,
        net_profit_usd_estimated: 9.5,
      },
      realized: opts.realized ?? {
        profit_wei: 100n,
        profit_usd: 10,
        gas_units_used: 100n,
        gas_usd_actual: 0.5,
        net_profit_usd: 9.5,
      },
      deltas: opts.deltas ?? {
        profit_delta_bps: 0,
        profit_delta_usd: 0,
        gas_delta_usd: 0,
        net_delta_usd: 0,
      },
      inclusion_cost: opts.inclusion_cost ?? {
        total_inclusion_usd: 0.5,
        inclusion_as_percent_of_profit: 0.05,
      },
      attribution: opts.attribution ?? {
        primary_cause: 'within_normal_band',
        confidence: 0.95,
        root_cause_details: '',
        automatable: false,
      },
      context: opts.context ?? {},
    };
  }

  it('observe + aggregate por protocol agrupa corretamente', () => {
    const a = new PnlAggregator();
    for (let i = 0; i < 5; i++) {
      a.observe(makeRecon({ protocol: 'aave-v3' }));
    }
    for (let i = 0; i < 3; i++) {
      a.observe(makeRecon({ protocol: 'compound-v3' }));
    }

    const byProto = a.aggregate('protocol', '7d');
    expect(byProto).toHaveLength(2);
    const aave = byProto.find((r) => r.key === 'aave-v3');
    const comp = byProto.find((r) => r.key === 'compound-v3');
    expect(aave?.samples).toBe(5);
    expect(comp?.samples).toBe(3);
    expect(aave?.win_rate).toBe(1.0); // all > 0 net
  });

  it('window prune filtra por timestamp', () => {
    const a = new PnlAggregator();
    a.observe(makeRecon({ timestamp: Date.now() - 200_000 })); // dentro 7d
    a.observe(makeRecon({ timestamp: Date.now() })); // dentro 7d

    expect(a.aggregate('protocol', '7d').length).toBeGreaterThan(0);
    expect(a.aggregate('protocol', '24h').length).toBeGreaterThan(0);
  });

  it('topPerformers ordena por win_rate * samples', () => {
    const a = new PnlAggregator();
    // protocol A: 5 wins
    for (let i = 0; i < 5; i++) {
      a.observe(makeRecon({
        protocol: 'aave-v3',
        realized: { profit_wei: 100n, profit_usd: 10, gas_units_used: 100n, gas_usd_actual: 0.5, net_profit_usd: 9.5 },
      }));
    }
    // protocol B: 3 losses
    for (let i = 0; i < 3; i++) {
      a.observe(makeRecon({
        protocol: 'compound-v3',
        realized: { profit_wei: 50n, profit_usd: 5, gas_units_used: 100n, gas_usd_actual: 6, net_profit_usd: -1 },
      }));
    }

    const top = a.topPerformers('protocol', '7d');
    expect(top[0]?.key).toBe('aave-v3');
  });

  it('worstPerformers retorna só com net_delta_usd negativo', () => {
    const a = new PnlAggregator();
    // Protocol A: realized > expected = positive delta
    for (let i = 0; i < 5; i++) {
      a.observe(makeRecon({
        protocol: 'aave-v3',
        expected: { profit_wei: 100n, profit_usd: 10, net_profit_usd_estimated: 9.5 },
        realized: { profit_wei: 100n, profit_usd: 12, gas_units_used: 100n, gas_usd_actual: 0.5, net_profit_usd: 11.5 },
      }));
    }
    // Protocol B: realized < expected = negative delta
    for (let i = 0; i < 5; i++) {
      a.observe(makeRecon({
        protocol: 'compound-v3',
        expected: { profit_wei: 100n, profit_usd: 10, net_profit_usd_estimated: 9.5 },
        realized: { profit_wei: 50n, profit_usd: 5, gas_units_used: 100n, gas_usd_actual: 0.5, net_profit_usd: 4.5 },
      }));
    }

    const worst = a.worstPerformers('protocol', '7d');
    expect(worst.length).toBe(1);
    expect(worst[0]?.key).toBe('compound-v3');
  });

  it('weeklySummary retorna estrutura completa', () => {
    const a = new PnlAggregator();
    a.observe(makeRecon({}));
    const summary = a.weeklySummary();
    expect(summary).toHaveProperty('by_protocol');
    expect(summary).toHaveProperty('by_venue');
    expect(summary).toHaveProperty('by_pair');
    expect(summary).toHaveProperty('by_hour_utc');
    expect(summary).toHaveProperty('worst_overall');
  });
});

describe('BuilderAttributionTracker — Item 5 F6', () => {
  const ourAccount = '0x1111111111111111111111111111111111111111' as `0x${string}`;
  const builderA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
  const builderB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;

  it('observeBlock conta our_txs vs competitor_txs', () => {
    const t = new BuilderAttributionTracker({ ourAccount });
    const competitor = '0x2222222222222222222222222222222222222222' as `0x${string}`;

    t.observeBlock(builderA, [ourAccount, competitor, competitor]);

    const stats = t.byBuilder(builderA);
    expect(stats?.total_blocks_seen).toBe(1);
    expect(stats?.our_txs_included).toBe(1);
    expect(stats?.competitor_txs_seen).toBe(2);
  });

  it('topByInclusion ordena por inclusion rate', () => {
    const t = new BuilderAttributionTracker({ ourAccount });
    // Builder A: 5 blocos, 4 com nossa tx
    for (let i = 0; i < 5; i++) {
      t.observeBlock(builderA, i < 4 ? [ourAccount] : []);
    }
    // Builder B: 5 blocos, 1 com nossa tx
    for (let i = 0; i < 5; i++) {
      t.observeBlock(builderB, i < 1 ? [ourAccount] : []);
    }

    const top = t.topByInclusion(2);
    expect(top[0]!.builder_address).toBe(builderA.toLowerCase());
    expect(top[0]!.our_inclusion_rate).toBe(0.8); // 4/5
    expect(top[1]!.our_inclusion_rate).toBe(0.2); // 1/5
  });

  it('lookupBuilder identifica known builders', () => {
    expect(lookupBuilder('0x690b9a9e9aa1c9db991c7721a92d351db4fac990' as `0x${string}`))
      .toBe('Flashbots Builder');
    expect(lookupBuilder('0x95222290dd7278aa3ddd389cc1e1d165cc4bafe5' as `0x${string}`))
      .toBe('Beaver Build');
    expect(lookupBuilder('0xunknown' as `0x${string}`)).toBeUndefined();
  });

  it('snapshot preserva data', () => {
    const t = new BuilderAttributionTracker({ ourAccount });
    t.observeBlock(builderA, [ourAccount]);
    const snap = t.snapshot();
    expect(Object.keys(snap)).toHaveLength(1);
    expect(snap[builderA.toLowerCase()]?.our_txs_included).toBe(1);
  });
});
