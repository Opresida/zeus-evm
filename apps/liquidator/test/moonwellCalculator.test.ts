/**
 * Testes do calculator Moonwell (closeFactor + incentive + profit).
 */

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import { calculateOptimalMoonwellLiquidation } from '../src/protocols/moonwell/calculator';
import type { MoonwellLiquidatablePosition } from '../src/types';
import { loadConfig } from '../src/config';

const env = loadConfig();

function mkPosition(over: Partial<MoonwellLiquidatablePosition> = {}): MoonwellLiquidatablePosition {
  return {
    borrower: '0xdEADbeEF00000000000000000000000000000001' as Address,
    mTokenBorrowed: '0x1111111111111111111111111111111111111111' as Address,
    borrowedUnderlying: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    borrowedSymbol: 'USDC',
    borrowedDecimals: 6,
    mTokenCollateral: '0x2222222222222222222222222222222222222222' as Address,
    collateralUnderlying: '0x4200000000000000000000000000000000000006' as Address,
    collateralSymbol: 'WETH',
    collateralDecimals: 18,
    borrowBalanceWei: 10_000n * 10n ** 6n, // 10k USDC dívida
    shortfallWei: 500n * 10n ** 18n,
    closeFactorMantissa: 5n * 10n ** 17n,   // 0.5 (50%)
    liquidationIncentiveMantissa: 108n * 10n ** 16n, // 1.08 (8% bônus)
    ...over,
  };
}

describe('calculateOptimalMoonwellLiquidation', () => {
  it('repayAmount = closeFactor × borrowBalance', () => {
    const out = calculateOptimalMoonwellLiquidation(mkPosition(), { env });
    expect(out.ok).toBe(true);
    // 50% de 10k USDC = 5k USDC
    expect(out.decision!.flashloanAmount).toBe(5_000n * 10n ** 6n);
  });

  it('expectedSwapOutput ≈ repayAmount × incentive', () => {
    const out = calculateOptimalMoonwellLiquidation(mkPosition(), { env });
    // 5000 × 1.08 = 5400 USDC
    expect(out.expectedSwapOutputWei).toBe(5_400n * 10n ** 6n);
  });

  it('profit ≈ repayAmount × (incentive - 1) - premium', () => {
    const out = calculateOptimalMoonwellLiquidation(mkPosition(), { env });
    // grossProfit ≈ 5400 - 5000 - premium(0.05% de 5000 = 2.5) = ~397.5 USDC
    expect(out.decision!.expectedProfitWei).toBeGreaterThan(390n * 10n ** 6n);
    expect(out.decision!.expectedProfitWei).toBeLessThan(400n * 10n ** 6n);
  });

  it('respeita cap on-chain (capWei)', () => {
    const out = calculateOptimalMoonwellLiquidation(mkPosition(), { env, capWei: 1_000n * 10n ** 6n });
    expect(out.decision!.flashloanAmount).toBe(1_000n * 10n ** 6n);
  });

  it('rejeita se incentive <= 1 (sem bônus)', () => {
    const out = calculateOptimalMoonwellLiquidation(
      mkPosition({ liquidationIncentiveMantissa: 10n ** 18n }), // 1.0 exato
      { env },
    );
    expect(out.ok).toBe(false);
    expect(out.reason?.toLowerCase()).toContain('incentive');
  });

  it('rejeita borrowBalance zero', () => {
    const out = calculateOptimalMoonwellLiquidation(mkPosition({ borrowBalanceWei: 0n }), { env });
    expect(out.ok).toBe(false);
  });

  it('minProfitWei é 50% do estimado (floor conservador)', () => {
    const out = calculateOptimalMoonwellLiquidation(mkPosition(), { env });
    expect(out.decision!.minProfitWei).toBe((out.decision!.expectedProfitWei * 5n) / 10n);
  });
});
