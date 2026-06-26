import { describe, expect, it } from 'vitest';
import { preLiquidationBand, planPreLiquidation, grossBonusAssets, type PreLiquidationConfig } from './math';

// Config real do mercado cbBTC/USDC na Base (lida on-chain na Fase 0).
const CFG: PreLiquidationConfig = {
  preLltv: 832603694978499652n, // 0.8326
  preLCF1: 2001493508968667n, // 0.002
  preLCF2: 245311807032632372n, // 0.2453
  preLIF1: 1043841336116910229n, // 1.0438
  preLIF2: 1043841336116910229n, // 1.0438 (igual → preLIF constante)
  lltv: 860000000000000000n, // 0.86
};

// 1 cbBTC (8 dec) a ~$60k → collateralQuoted = 6e10 (USDC 6dec).
const COLLATERAL = 100_000_000n; // 1e8
const PRICE = 600_000_000_000_000_000_000_000_000_000_000_000_000n; // 6e38
// totais grandes 1:1 → toAssets ≈ borrowShares.
const MARKET = { totalBorrowAssets: 10n ** 30n, totalBorrowShares: 10n ** 30n };
const pos = (borrowShares: bigint) => ({ borrowShares, collateral: COLLATERAL });

describe('preLiquidationBand', () => {
  it("'below' quando LTV <= preLltv", () => {
    // maxBorrow@preLltv = 6e10 × 0.8326 = 4.9956e10 → borrowed 4.9e10 fica abaixo
    expect(preLiquidationBand(pos(49_000_000_000n), MARKET, PRICE, CFG)).toBe('below');
  });
  it("'pre' quando preLltv < LTV <= LLTV", () => {
    // borrowed 5.1e10 → LTV ~0.85 (entre 0.8326 e 0.86)
    expect(preLiquidationBand(pos(51_000_000_000n), MARKET, PRICE, CFG)).toBe('pre');
  });
  it("'liquidatable' quando LTV > LLTV", () => {
    // maxBorrow@LLTV = 5.16e10 → borrowed 5.3e10 ultrapassa
    expect(preLiquidationBand(pos(53_000_000_000n), MARKET, PRICE, CFG)).toBe('liquidatable');
  });
  it('null sem dívida/colateral/preço', () => {
    expect(preLiquidationBand({ borrowShares: 0n, collateral: COLLATERAL }, MARKET, PRICE, CFG)).toBeNull();
    expect(preLiquidationBand(pos(51_000_000_000n), MARKET, 0n, CFG)).toBeNull();
  });
});

describe('planPreLiquidation', () => {
  it('null fora da faixa pre', () => {
    expect(planPreLiquidation(pos(49_000_000_000n), MARKET, PRICE, CFG)).toBeNull(); // below
    expect(planPreLiquidation(pos(53_000_000_000n), MARKET, PRICE, CFG)).toBeNull(); // liquidatable
  });

  it('na faixa pre: plano coerente com o contrato', () => {
    const p = planPreLiquidation(pos(51_000_000_000n), MARKET, PRICE, CFG);
    expect(p).not.toBeNull();
    if (!p) return;
    // LTV ~0.85 (WAD)
    expect(p.ltv).toBeGreaterThan(CFG.preLltv);
    expect(p.ltv).toBeLessThanOrEqual(CFG.lltv);
    // preLIF constante = 1.0438 (preLIF1==preLIF2)
    expect(p.preLIF).toBe(CFG.preLIF1);
    // close factor interpolado entre preLCF1 e preLCF2
    expect(p.preLCF).toBeGreaterThan(CFG.preLCF1);
    expect(p.preLCF).toBeLessThan(CFG.preLCF2);
    // fatia dentro do teto (preLCF × borrowShares)
    const repayable = (51_000_000_000n * p.preLCF) / 10n ** 18n;
    expect(p.repaidShares).toBeLessThanOrEqual(repayable);
    expect(p.repaidShares).toBeGreaterThan(0n);
    // seiza menos que o colateral total (parcial) e algo > 0
    expect(p.expectedSeizedCollateral).toBeGreaterThan(0n);
    expect(p.expectedSeizedCollateral).toBeLessThan(COLLATERAL);
    // repaga algo em loanToken
    expect(p.expectedRepaidAssets).toBeGreaterThan(0n);
    // o bônus existe (seized vale mais que o repaid) — onde mora o lucro pré-swap
    expect(grossBonusAssets(p, PRICE)).toBeGreaterThan(0n);
  });
});
