/**
 * Smoke test do ChainlinkStalenessChecker (Grupo B).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

import { ChainlinkStalenessChecker } from '../src/oracle';

function makeClient(readContract: ReturnType<typeof vi.fn>) {
  return { readContract } as any;
}

const FEED_A = '0xaaaa000000000000000000000000000000000001' as Address;
const FEED_B = '0xbbbb000000000000000000000000000000000001' as Address;
const ASSET_USDC = '0x1111000000000000000000000000000000000001' as Address;
const ASSET_WETH = '0x2222000000000000000000000000000000000001' as Address;
const AAVE_ORACLE = '0x3333000000000000000000000000000000000001' as Address;

describe('ChainlinkStalenessChecker — Grupo B', () => {
  it('feed fresh: updatedAt agora → fresh', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const readContract = vi.fn().mockResolvedValue([1n, 100_000_000n, BigInt(nowSec - 10), BigInt(nowSec - 10), 1n]);
    const checker = new ChainlinkStalenessChecker(makeClient(readContract), { defaultThresholdSec: 3600 });

    const r = await checker.checkFeed(FEED_A);
    expect(r.status).toBe('fresh');
    expect(r.age_seconds).toBeLessThan(30);
    expect(r.threshold_seconds).toBe(3600);
  });

  it('feed stale: updatedAt 2h atrás com threshold 1h → stale', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const readContract = vi.fn().mockResolvedValue([1n, 100_000_000n, BigInt(nowSec - 7200), BigInt(nowSec - 7200), 1n]);
    const checker = new ChainlinkStalenessChecker(makeClient(readContract), { defaultThresholdSec: 3600 });

    const r = await checker.checkFeed(FEED_A);
    expect(r.status).toBe('stale');
    expect(r.age_seconds).toBeGreaterThan(7000);
  });

  it('feed inválido: answer<=0 → status=invalid', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const readContract = vi.fn().mockResolvedValue([1n, 0n, BigInt(nowSec), BigInt(nowSec), 1n]);
    const checker = new ChainlinkStalenessChecker(makeClient(readContract));

    const r = await checker.checkFeed(FEED_A);
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('answer<=0');
  });

  it('RPC erro → status=unknown (fail-open)', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    const checker = new ChainlinkStalenessChecker(makeClient(readContract));

    const r = await checker.checkFeed(FEED_A);
    expect(r.status).toBe('unknown');
    expect(r.reason).toContain('RPC timeout');
  });

  it('threshold override por asset: stable 24h, BTC 1h', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let call = 0;
    const readContract = vi.fn().mockImplementation((args: { functionName: string }) => {
      // getSourceOfAsset retorna FEED_A
      if (args.functionName === 'getSourceOfAsset') return Promise.resolve(FEED_A);
      // latestRoundData: updatedAt 2h atrás
      call++;
      return Promise.resolve([1n, 100_000_000n, BigInt(nowSec - 7200), BigInt(nowSec - 7200), 1n]);
    });

    const checker = new ChainlinkStalenessChecker(makeClient(readContract), {
      defaultThresholdSec: 3600,
      thresholdOverrides: {
        [ASSET_USDC.toLowerCase()]: 86400, // stables: 24h tolerável
      },
    });

    // USDC com 2h de idade e threshold 24h → fresh
    const usdcResult = await checker.checkAaveAssetStaleness(AAVE_ORACLE, ASSET_USDC);
    expect(usdcResult.status).toBe('fresh');
    expect(usdcResult.threshold_seconds).toBe(86400);

    // WETH com 2h de idade e threshold default 1h → stale
    const wethResult = await checker.checkAaveAssetStaleness(AAVE_ORACLE, ASSET_WETH);
    expect(wethResult.status).toBe('stale');
    expect(wethResult.threshold_seconds).toBe(3600);
  });

  it('batch check: assets em paralelo', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const readContract = vi.fn().mockImplementation((args: { functionName: string; args?: any[] }) => {
      if (args.functionName === 'getSourceOfAsset') {
        const asset = (args.args?.[0] as string).toLowerCase();
        return Promise.resolve(asset === ASSET_USDC.toLowerCase() ? FEED_A : FEED_B);
      }
      return Promise.resolve([1n, 100_000_000n, BigInt(nowSec - 10), BigInt(nowSec - 10), 1n]);
    });

    const checker = new ChainlinkStalenessChecker(makeClient(readContract));
    const results = await checker.checkAaveAssetsStaleness(AAVE_ORACLE, [ASSET_USDC, ASSET_WETH]);
    expect(results.size).toBe(2);
    expect(results.get(ASSET_USDC.toLowerCase())?.status).toBe('fresh');
    expect(results.get(ASSET_WETH.toLowerCase())?.status).toBe('fresh');
  });

  it('cache feed: 2ª lookup do mesmo asset não chama RPC', async () => {
    const readContract = vi.fn().mockImplementation((args: { functionName: string }) => {
      if (args.functionName === 'getSourceOfAsset') return Promise.resolve(FEED_A);
      return Promise.resolve([1n, 100_000_000n, BigInt(Math.floor(Date.now() / 1000) - 10), BigInt(Math.floor(Date.now() / 1000) - 10), 1n]);
    });

    const checker = new ChainlinkStalenessChecker(makeClient(readContract));
    await checker.resolveAaveFeed(AAVE_ORACLE, ASSET_USDC);
    await checker.resolveAaveFeed(AAVE_ORACLE, ASSET_USDC);

    const getSourceCalls = readContract.mock.calls.filter(([args]: any) => args.functionName === 'getSourceOfAsset');
    expect(getSourceCalls.length).toBe(1); // 2ª foi do cache
  });

  it('allFresh helper: fail se algum stale', () => {
    const fresh = new Map([
      ['a', { status: 'fresh' as const, threshold_seconds: 3600 }],
      ['b', { status: 'fresh' as const, threshold_seconds: 3600 }],
    ]);
    expect(ChainlinkStalenessChecker.allFresh(fresh)).toBe(true);

    const oneStale = new Map([
      ['a', { status: 'fresh' as const, threshold_seconds: 3600 }],
      ['b', { status: 'stale' as const, threshold_seconds: 3600 }],
    ]);
    expect(ChainlinkStalenessChecker.allFresh(oneStale)).toBe(false);

    const oneUnknown = new Map([
      ['a', { status: 'fresh' as const, threshold_seconds: 3600 }],
      ['b', { status: 'unknown' as const, threshold_seconds: 3600 }],
    ]);
    expect(ChainlinkStalenessChecker.allFresh(oneUnknown)).toBe(true); // fail-open default
    expect(ChainlinkStalenessChecker.allFresh(oneUnknown, { strictUnknown: true })).toBe(false);
  });
});
