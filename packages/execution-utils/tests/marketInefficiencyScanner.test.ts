/**
 * Testes do MIS — foco no ranking por PERSISTÊNCIA (tese central do Motor 2).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

import {
  MarketInefficiencyScanner,
  type InefficiencyObservation,
} from '../src/arb';

const WETH = '0x4200000000000000000000000000000000000006' as Address;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;

function mkObs(group: string, divBps: number, ts = Date.now()): InefficiencyObservation {
  return {
    groupLabel: group,
    timestamp: ts,
    maxDivergenceBps: divBps,
    poolsWithPrice: 2,
    direction: 'buyA_sellB',
  };
}

describe('MIS — registro + stats', () => {
  it('registerGroup conta grupos', () => {
    const mis = new MarketInefficiencyScanner();
    mis.registerGroup({ label: 'WETH/USDC', tokenA: WETH, tokenB: USDC, decimalsA: 18, decimalsB: 6, pools: [] });
    expect(mis.groupCount()).toBe(1);
  });
});

describe('MIS — ranking por persistência (tese central)', () => {
  it('par que diverge SEMPRE rankeia acima de par que divergiu 1x com magnitude maior', () => {
    const mis = new MarketInefficiencyScanner({ minDivergenceBps: 20 });

    // Grupo "persistente": 10 amostras todas com 30 bps (persistência 100%)
    for (let i = 0; i < 10; i++) mis.recordSample(mkObs('persistente', 30));

    // Grupo "spike": 9 amostras com 0 bps + 1 com 200 bps (persistência 10%, mas pico alto)
    for (let i = 0; i < 9; i++) mis.recordSample(mkObs('spike', 0));
    mis.recordSample(mkObs('spike', 200));

    const ranking = mis.ranking();
    expect(ranking[0]!.groupLabel).toBe('persistente'); // persistência vence magnitude pontual
    expect(ranking[0]!.persistenceRatio).toBe(1);

    const spike = ranking.find((r) => r.groupLabel === 'spike')!;
    expect(spike.persistenceRatio).toBeCloseTo(0.1, 2);
    expect(ranking[0]!.score).toBeGreaterThan(spike.score);
  });

  it('score = persistenceRatio × avgDivergenceBps', () => {
    const mis = new MarketInefficiencyScanner({ minDivergenceBps: 20 });
    // 4 amostras: 2 acima (30,30) + 2 abaixo (10,10). persistência 0.5, avg 20
    mis.recordSample(mkObs('g', 30));
    mis.recordSample(mkObs('g', 30));
    mis.recordSample(mkObs('g', 10));
    mis.recordSample(mkObs('g', 10));
    const r = mis.ranking()[0]!;
    expect(r.persistenceRatio).toBe(0.5);
    expect(r.avgDivergenceBps).toBe(20);
    expect(r.score).toBe(10); // 0.5 × 20
  });

  it('avgDivergenceBps e maxDivergenceBps corretos', () => {
    const mis = new MarketInefficiencyScanner();
    mis.recordSample(mkObs('g', 10));
    mis.recordSample(mkObs('g', 50));
    const r = mis.ranking()[0]!;
    expect(r.avgDivergenceBps).toBe(30);
    expect(r.maxDivergenceBps).toBe(50);
  });

  it('window prune remove amostras velhas', () => {
    vi.useFakeTimers();
    const mis = new MarketInefficiencyScanner({ windowMs: 1000 });
    mis.recordSample(mkObs('g', 30, Date.now()));
    expect(mis.stats().totalSamples).toBe(1);
    vi.advanceTimersByTime(2000);
    mis.recordSample(mkObs('g', 30, Date.now()));
    expect(mis.stats().totalSamples).toBe(1); // velha foi podada
    vi.useRealTimers();
  });
});

describe('MIS — persistência (padrão liga/desliga diário)', () => {
  it('snapshot + restore preserva histórico entre sessões', () => {
    const mis1 = new MarketInefficiencyScanner();
    for (let i = 0; i < 5; i++) mis1.recordSample(mkObs('cbETH/WETH', 30));
    const snap = mis1.snapshot();

    // Nova instância (simula reiniciar amanhã) restaura
    const mis2 = new MarketInefficiencyScanner();
    mis2.restore(snap);
    expect(mis2.stats().totalSamples).toBe(5);
    expect(mis2.ranking()[0]!.groupLabel).toBe('cbETH/WETH');
  });

  it('restore aplica prune da janela (amostras velhas não voltam)', () => {
    vi.useFakeTimers();
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 dias atrás
    const snap = { 'g': [mkObs('g', 30, old), mkObs('g', 30, Date.now())] };
    const mis = new MarketInefficiencyScanner({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    mis.restore(snap);
    expect(mis.stats().totalSamples).toBe(1); // só a recente sobrevive
    vi.useRealTimers();
  });
});

describe('MIS — scanGroup com pools reais (mock)', () => {
  it('detecta divergência entre 2 pools UniV3 do mesmo par', async () => {
    const Q96 = 2n ** 96n;
    // Pool A: sqrtPriceX96 = 2×Q96 → price 4. Pool B: sqrt tal que price ~4.04 (1% acima)
    const sqrtA = 2n * Q96;
    const sqrtB = (2020n * Q96) / 1000n; // ~price 4.08

    const poolA = '0xaAaA000000000000000000000000000000000001' as Address;
    const poolB = '0xbBbB000000000000000000000000000000000001' as Address;

    const readContract = vi.fn();
    const multicall = vi.fn().mockImplementation(({ contracts }: { contracts: Array<{ address: string; functionName: string }> }) => {
      const pool = contracts[0]!.address.toLowerCase();
      const sqrt = pool === poolA.toLowerCase() ? sqrtA : sqrtB;
      return Promise.resolve([
        { status: 'success', result: [sqrt, 0, 0, 0, 0, 0, true] }, // slot0
        { status: 'success', result: WETH },  // token0
        { status: 'success', result: USDC },  // token1
        { status: 'success', result: 500 },   // fee
        { status: 'success', result: 10n ** 18n }, // liquidity
      ]);
    });
    const client = { multicall, readContract } as any;

    const mis = new MarketInefficiencyScanner({ minDivergenceBps: 20 });
    mis.registerGroup({
      label: 'WETH/USDC',
      tokenA: WETH,
      tokenB: USDC,
      decimalsA: 18,
      decimalsB: 18,
      pools: [
        { dex: 'univ3', pool: poolA, label: 'UniV3-500-A' },
        { dex: 'univ3', pool: poolB, label: 'UniV3-500-B' },
      ],
    });

    const obs = await mis.scanGroup(client, 'WETH/USDC');
    expect(obs).not.toBeNull();
    expect(obs!.poolsWithPrice).toBe(2);
    expect(obs!.maxDivergenceBps).toBeGreaterThan(0);
    expect(obs!.cheapPool).toBe('UniV3-500-A'); // price 4 < price ~4.08
  });
});
