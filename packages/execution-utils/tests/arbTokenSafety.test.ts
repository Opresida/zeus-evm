/**
 * Testes do Token Safety (Motor 2) — allowlist + checagem de par/rota.
 */

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import {
  buildArbAllowlist,
  isArbTokenAllowed,
  checkArbPair,
  checkArbRoute,
} from '../src/arb';

const WETH = '0x4200000000000000000000000000000000000006' as Address;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const cbETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as Address;
const SCAM = '0xBaDBaDBaDBaDBaDBaDBaDBaDBaDBaDBaDBaDBaD0' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

const chainTokens = {
  ETH: ZERO,        // deve ser ignorado (zero address)
  WETH,
  USDC,
  cbETH,
};

describe('Token Safety — allowlist', () => {
  it('buildArbAllowlist inclui tokens do chain-config (ignora zero)', () => {
    const allow = buildArbAllowlist(chainTokens);
    expect(allow.tokens.size).toBe(3); // WETH, USDC, cbETH (ETH zero ignorado)
    expect(isArbTokenAllowed(allow, WETH)).toBe(true);
    expect(isArbTokenAllowed(allow, USDC)).toBe(true);
  });

  it('extra tokens são adicionados', () => {
    const extra = '0x1111111111111111111111111111111111111111' as Address;
    const allow = buildArbAllowlist(chainTokens, [extra]);
    expect(isArbTokenAllowed(allow, extra)).toBe(true);
  });

  it('token fora da allowlist é rejeitado', () => {
    const allow = buildArbAllowlist(chainTokens);
    expect(isArbTokenAllowed(allow, SCAM)).toBe(false);
  });

  it('case-insensitive (lowercase normalizado)', () => {
    const allow = buildArbAllowlist(chainTokens);
    expect(isArbTokenAllowed(allow, WETH.toUpperCase() as Address)).toBe(true);
  });
});

describe('Token Safety — checkArbPair', () => {
  const allow = buildArbAllowlist(chainTokens);

  it('par com ambos na allowlist → ok', () => {
    expect(checkArbPair(allow, WETH, USDC).ok).toBe(true);
  });

  it('par com tokenA fora → rejeita com reason', () => {
    const r = checkArbPair(allow, SCAM, USDC);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('allowlist');
  });

  it('par com tokenB fora → rejeita', () => {
    expect(checkArbPair(allow, WETH, SCAM).ok).toBe(false);
  });
});

describe('Token Safety — checkArbRoute (triangular/multi-hop)', () => {
  const allow = buildArbAllowlist(chainTokens);

  it('rota triangular toda na allowlist → ok', () => {
    expect(checkArbRoute(allow, [WETH, USDC, cbETH, WETH]).ok).toBe(true);
  });

  it('rota com 1 token suspeito no meio → rejeita', () => {
    const r = checkArbRoute(allow, [WETH, SCAM, USDC]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('path');
  });
});
