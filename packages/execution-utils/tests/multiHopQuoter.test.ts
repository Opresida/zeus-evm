/**
 * Smoke test do multi-hop quoter (Grupo B).
 */

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { encodeUniV3Path, buildCandidateRoutes } from '@zeus-evm/dex-adapters';

const USDC = '0x1111000000000000000000000000000000000001' as Address;
const WETH = '0x2222000000000000000000000000000000000001' as Address;
const WBTC = '0x3333000000000000000000000000000000000001' as Address;
const DAI = '0x4444000000000000000000000000000000000001' as Address;

describe('encodeUniV3Path — Grupo B', () => {
  it('single-hop: 20 + 3 + 20 = 43 bytes', () => {
    const path = encodeUniV3Path([USDC, WETH], [500]);
    // hex string: 0x + 2 chars per byte = 0x + 86 chars (43 bytes)
    expect(path.length).toBe(2 + 43 * 2);
  });

  it('2-hops: 20 + 3 + 20 + 3 + 20 = 66 bytes', () => {
    const path = encodeUniV3Path([WBTC, WETH, USDC], [3000, 500]);
    expect(path.length).toBe(2 + 66 * 2);
  });

  it('3-hops: 89 bytes', () => {
    const path = encodeUniV3Path([WBTC, WETH, USDC, DAI], [3000, 500, 100]);
    expect(path.length).toBe(2 + 89 * 2);
  });

  it('reject: tokens.length=1', () => {
    expect(() => encodeUniV3Path([USDC], [500])).toThrow(/pelo menos 2/);
  });

  it('reject: fees.length mismatch', () => {
    expect(() => encodeUniV3Path([USDC, WETH], [500, 3000])).toThrow(/tokens.length - 1/);
  });
});

describe('buildCandidateRoutes — Grupo B', () => {
  it('zero intermediates: só single-hop em 3 fee tiers', () => {
    const routes = buildCandidateRoutes({
      tokenIn: WBTC,
      tokenOut: USDC,
      intermediates: [],
    });
    expect(routes.length).toBe(3);
    expect(routes.every((r) => r.tokens.length === 2)).toBe(true);
  });

  it('1 intermediate WETH: 3 single + 9 2-hops (3×3 fee tiers)', () => {
    const routes = buildCandidateRoutes({
      tokenIn: WBTC,
      tokenOut: USDC,
      intermediates: [WETH],
      maxRoutes: 20,
    });
    expect(routes.length).toBe(12); // 3 + 9
    const twoHops = routes.filter((r) => r.tokens.length === 3);
    expect(twoHops.length).toBe(9);
    expect(twoHops.every((r) => r.tokens[1] === WETH)).toBe(true);
  });

  it('maxRoutes cap respeita limite', () => {
    const routes = buildCandidateRoutes({
      tokenIn: WBTC,
      tokenOut: USDC,
      intermediates: [WETH, DAI],
      maxRoutes: 6,
    });
    expect(routes.length).toBe(6);
  });

  it('intermediate == tokenIn/tokenOut: skip (não pode WBTC→WBTC→USDC)', () => {
    const routes = buildCandidateRoutes({
      tokenIn: WBTC,
      tokenOut: USDC,
      intermediates: [WBTC, USDC, WETH],
    });
    // só WETH é válido como intermediate
    const twoHops = routes.filter((r) => r.tokens.length === 3);
    expect(twoHops.every((r) => r.tokens[1] === WETH)).toBe(true);
  });
});
