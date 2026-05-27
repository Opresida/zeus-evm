/**
 * Smoke test do multi-collateral evaluation (Grupo B).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

import { resolveAllBorrowerPositionPairs, type AaveReservesCache } from '@zeus-evm/aave-discovery';

const USDC = '0x1111000000000000000000000000000000000001' as Address;
const WETH = '0x2222000000000000000000000000000000000001' as Address;
const WBTC = '0x3333000000000000000000000000000000000001' as Address;
const DAI = '0x4444000000000000000000000000000000000001' as Address;
const POOL_DATA_PROVIDER = '0x5555000000000000000000000000000000000001' as Address;
const BORROWER = '0x6666000000000000000000000000000000000001' as Address;

function makeCache(reserves: Address[]): AaveReservesCache {
  return {
    poolDataProvider: POOL_DATA_PROVIDER,
    reserves,
    info: new Map(),
  } as AaveReservesCache;
}

function makeClient(multicall: ReturnType<typeof vi.fn>) {
  return { multicall } as any;
}

describe('Multi-collateral evaluation — Grupo B', () => {
  it('1 collateral + 1 debt → 1 par retornado', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: [100n, 0n, 0n, 0n, 0n, 0n, 0n, 0, true] },  // USDC collateral
      { status: 'success', result: [0n, 0n, 50n, 0n, 0n, 0n, 0n, 0, false] },  // WETH debt
    ]);
    const pairs = await resolveAllBorrowerPositionPairs({
      client: makeClient(multicall),
      cache: makeCache([USDC, WETH]),
      borrower: BORROWER,
    });
    expect(pairs.length).toBe(1);
    expect(pairs[0]?.collateralAsset).toBe(USDC);
    expect(pairs[0]?.debtAsset).toBe(WETH);
  });

  it('2 collaterals + 2 debts → 4 pares (produto cartesiano)', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: [1000n, 0n, 0n, 0n, 0n, 0n, 0n, 0, true] },   // USDC collat
      { status: 'success', result: [500n, 0n, 0n, 0n, 0n, 0n, 0n, 0, true] },    // WBTC collat
      { status: 'success', result: [0n, 0n, 200n, 0n, 0n, 0n, 0n, 0, false] },   // WETH debt
      { status: 'success', result: [0n, 0n, 100n, 0n, 0n, 0n, 0n, 0, false] },   // DAI debt
    ]);
    const pairs = await resolveAllBorrowerPositionPairs({
      client: makeClient(multicall),
      cache: makeCache([USDC, WBTC, WETH, DAI]),
      borrower: BORROWER,
    });
    expect(pairs.length).toBe(4);

    const combos = new Set(pairs.map((p) => `${p.collateralAsset}|${p.debtAsset}`));
    expect(combos.has(`${USDC}|${WETH}`)).toBe(true);
    expect(combos.has(`${USDC}|${DAI}`)).toBe(true);
    expect(combos.has(`${WBTC}|${WETH}`)).toBe(true);
    expect(combos.has(`${WBTC}|${DAI}`)).toBe(true);
  });

  it('usageAsCollateral=false → não conta como collateral mesmo com balance', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: [1000n, 0n, 0n, 0n, 0n, 0n, 0n, 0, false] }, // collat OFF
      { status: 'success', result: [500n, 0n, 0n, 0n, 0n, 0n, 0n, 0, true] },   // collat ON
      { status: 'success', result: [0n, 0n, 100n, 0n, 0n, 0n, 0n, 0, false] },  // debt
    ]);
    const pairs = await resolveAllBorrowerPositionPairs({
      client: makeClient(multicall),
      cache: makeCache([USDC, WBTC, WETH]),
      borrower: BORROWER,
    });
    expect(pairs.length).toBe(1); // só WBTC×WETH (USDC desativado)
    expect(pairs[0]?.collateralAsset).toBe(WBTC);
  });

  it('zero collateral viável → array vazio (não null)', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: [0n, 0n, 100n, 0n, 0n, 0n, 0n, 0, false] },  // só debt
    ]);
    const pairs = await resolveAllBorrowerPositionPairs({
      client: makeClient(multicall),
      cache: makeCache([USDC]),
      borrower: BORROWER,
    });
    expect(pairs).toEqual([]);
  });

  it('zero debt → array vazio', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: [1000n, 0n, 0n, 0n, 0n, 0n, 0n, 0, true] },
    ]);
    const pairs = await resolveAllBorrowerPositionPairs({
      client: makeClient(multicall),
      cache: makeCache([USDC]),
      borrower: BORROWER,
    });
    expect(pairs).toEqual([]);
  });

  it('stable debt + variable debt somam pro mesmo asset', async () => {
    const multicall = vi.fn().mockResolvedValue([
      { status: 'success', result: [1000n, 0n, 0n, 0n, 0n, 0n, 0n, 0, true] },   // USDC collat
      { status: 'success', result: [0n, 50n, 50n, 0n, 0n, 0n, 0n, 0, false] },   // WETH debt: 50 stable + 50 variable
    ]);
    const pairs = await resolveAllBorrowerPositionPairs({
      client: makeClient(multicall),
      cache: makeCache([USDC, WETH]),
      borrower: BORROWER,
    });
    expect(pairs[0]?.debtBalanceWei).toBe(100n); // soma
  });
});
