/**
 * Testes da matemática Morpho Blue (parte crítica — divergência aqui = revert on-chain).
 *
 * Valida shares math, health factor, LIF e planLiquidation contra a lógica do contrato.
 */

import { describe, expect, it } from 'vitest';

import {
  WAD,
  ORACLE_PRICE_SCALE,
  MAX_LIQUIDATION_INCENTIVE_FACTOR,
  toAssetsUp,
  toAssetsDown,
  toSharesUp,
  borrowedAssets,
  maxBorrowAssets,
  healthFactor,
  isLiquidatable,
  liquidationIncentiveFactor,
  planLiquidation,
} from '../src/protocols/morpho/math';

describe('Morpho shares math (virtual shares)', () => {
  it('toAssetsUp/Down com virtual shares', () => {
    // Market vazio: shares começam 1:1e6 (VIRTUAL_SHARES)
    // 1e6 shares de um market com 1 asset / 1e6 shares → ~1 asset
    const totalAssets = 1000n * 10n ** 6n; // 1000 USDC
    const totalShares = 1000n * 10n ** 6n * 10n ** 6n; // shares scaled
    const shares = 10n ** 6n * 10n ** 6n; // 1 USDC em shares
    const assetsUp = toAssetsUp(shares, totalAssets, totalShares);
    const assetsDown = toAssetsDown(shares, totalAssets, totalShares);
    expect(assetsUp).toBeGreaterThanOrEqual(assetsDown);
    expect(assetsDown).toBeGreaterThan(0n);
  });

  it('toSharesUp arredonda pra cima', () => {
    const totalAssets = 1000n;
    const totalShares = 1000n * 10n ** 6n;
    const s = toSharesUp(100n, totalAssets, totalShares);
    expect(s).toBeGreaterThan(0n);
  });
});

describe('Morpho health factor + liquidatable', () => {
  // Cenário: collateral 1 WETH (1e18), price = 2000e36/1e18...
  // Morpho oracle price scale: collateralValue = collateral * price / 1e36 (em loanToken)
  // Pra 1 WETH valer 2000 USDC (6 dec): price = 2000e6 * 1e36 / 1e18 = 2000e24
  const price = 2000n * 10n ** 6n * ORACLE_PRICE_SCALE / 10n ** 18n; // loanToken(6dec) por collateral(18dec)
  const lltv = 86n * 10n ** 16n; // 0.86e18

  it('position saudável: borrowed < maxBorrow → não liquidável', () => {
    const position = { borrowShares: 1000n * 10n ** 6n * 10n ** 6n, collateral: 10n ** 18n }; // 1 WETH
    const market = { totalBorrowAssets: 1000n * 10n ** 6n, totalBorrowShares: 1000n * 10n ** 6n * 10n ** 6n };
    // borrowed ~1000 USDC, collateral vale 2000, maxBorrow = 2000*0.86 = 1720 > 1000 → saudável
    expect(isLiquidatable(position, market, price, lltv)).toBe(false);
    expect(healthFactor(position, market, price, lltv)).toBeGreaterThan(WAD);
  });

  it('position underwater: borrowed > maxBorrow → liquidável', () => {
    // borrowed ~1800 USDC, collateral vale 2000, maxBorrow = 1720 < 1800 → liquidável
    const position = { borrowShares: 1800n * 10n ** 6n * 10n ** 6n, collateral: 10n ** 18n };
    const market = { totalBorrowAssets: 1800n * 10n ** 6n, totalBorrowShares: 1800n * 10n ** 6n * 10n ** 6n };
    expect(isLiquidatable(position, market, price, lltv)).toBe(true);
    expect(healthFactor(position, market, price, lltv)).toBeLessThan(WAD);
  });

  it('borrowed=0 → saudável (HF max)', () => {
    const position = { borrowShares: 0n, collateral: 10n ** 18n };
    const market = { totalBorrowAssets: 0n, totalBorrowShares: 0n };
    expect(isLiquidatable(position, market, price, lltv)).toBe(false);
  });

  it('maxBorrowAssets = collateral × price / 1e36 × lltv', () => {
    const collateral = 10n ** 18n; // 1 WETH
    const mb = maxBorrowAssets(collateral, price, lltv);
    // collateralValue = 2000e6, × 0.86 = 1720e6
    expect(mb).toBe(1720n * 10n ** 6n);
  });
});

describe('Morpho liquidation incentive factor', () => {
  it('LIF cresce conforme lltv cai (mais risco = mais bônus)', () => {
    const lifHighLltv = liquidationIncentiveFactor(945n * 10n ** 15n); // 0.945 (conservador)
    const lifLowLltv = liquidationIncentiveFactor(50n * 10n ** 16n);   // 0.50 (arriscado)
    expect(lifLowLltv).toBeGreaterThan(lifHighLltv);
  });

  it('LIF respeita o cap MAX (1.15e18)', () => {
    const lif = liquidationIncentiveFactor(10n * 10n ** 16n); // 0.10 lltv extremo
    expect(lif).toBeLessThanOrEqual(MAX_LIQUIDATION_INCENTIVE_FACTOR);
  });

  it('LIF sempre >= 1 (bônus nunca negativo)', () => {
    const lif = liquidationIncentiveFactor(86n * 10n ** 16n);
    expect(lif).toBeGreaterThanOrEqual(WAD);
  });
});

describe('Morpho planLiquidation', () => {
  const price = 2000n * 10n ** 6n * ORACLE_PRICE_SCALE / 10n ** 18n;
  const lltv = 86n * 10n ** 16n;

  it('repayAll quando colateral cobre a dívida toda + bônus', () => {
    // Dívida pequena vs colateral grande → repaga tudo
    const position = { borrowShares: 100n * 10n ** 6n * 10n ** 6n, collateral: 10n ** 18n };
    const market = { totalBorrowAssets: 100n * 10n ** 6n, totalBorrowShares: 100n * 10n ** 6n * 10n ** 6n };
    const plan = planLiquidation(position, market, price, lltv);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe('repayAll');
    expect(plan!.repaidShares).toBe(position.borrowShares);
    expect(plan!.seizedAssets).toBe(0n);
    expect(plan!.expectedSeizedCollateral).toBeGreaterThan(0n);
    expect(plan!.expectedSeizedCollateral).toBeLessThanOrEqual(position.collateral);
  });

  it('seizeAll quando dívida excede o que o colateral cobre', () => {
    // Dívida enorme vs colateral pequeno → seiza todo colateral
    const position = { borrowShares: 5000n * 10n ** 6n * 10n ** 6n, collateral: 10n ** 18n };
    const market = { totalBorrowAssets: 5000n * 10n ** 6n, totalBorrowShares: 5000n * 10n ** 6n * 10n ** 6n };
    const plan = planLiquidation(position, market, price, lltv);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe('seizeAll');
    expect(plan!.seizedAssets).toBe(position.collateral);
    expect(plan!.repaidShares).toBe(0n);
  });

  it('null quando sem dívida ou colateral', () => {
    const market = { totalBorrowAssets: 0n, totalBorrowShares: 0n };
    expect(planLiquidation({ borrowShares: 0n, collateral: 10n ** 18n }, market, price, lltv)).toBeNull();
    expect(planLiquidation({ borrowShares: 100n, collateral: 0n }, market, price, lltv)).toBeNull();
  });
});
