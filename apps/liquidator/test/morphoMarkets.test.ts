/**
 * Teste do computeMorphoMarketId — id determinístico = keccak256(abi.encode(params)).
 */

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { computeMorphoMarketId } from '../src/protocols/morpho/markets';

describe('computeMorphoMarketId', () => {
  const params = {
    loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address, // USDC Base
    collateralToken: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as Address, // cbETH
    oracle: '0x1111111111111111111111111111111111111111' as Address,
    irm: '0x2222222222222222222222222222222222222222' as Address,
    lltv: 86n * 10n ** 16n,
  };

  it('retorna bytes32 (0x + 64 hex)', () => {
    const id = computeMorphoMarketId(params);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('determinístico: mesmos params = mesmo id', () => {
    expect(computeMorphoMarketId(params)).toBe(computeMorphoMarketId(params));
  });

  it('params diferentes = ids diferentes', () => {
    const other = { ...params, lltv: 90n * 10n ** 16n };
    expect(computeMorphoMarketId(params)).not.toBe(computeMorphoMarketId(other));
  });
});
