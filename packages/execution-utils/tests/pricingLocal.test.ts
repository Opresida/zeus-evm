/**
 * Testes do pricing local (UniV3 + Aerodrome) — fundação do MIS (Motor 2).
 * Math sensível — validada contra valores conhecidos.
 */

import { describe, expect, it } from 'vitest';

import {
  uniV3SpotPrice1e18,
  uniV3SpotPriceInverse1e18,
  aeroVolatileSpotPrice1e18,
  aeroStableSpotPrice1e18,
  priceDivergenceBps,
  arbDirection,
} from '@zeus-evm/dex-adapters';

const WAD = 10n ** 18n;
const Q96 = 2n ** 96n;

describe('UniV3 spot pricing', () => {
  it('sqrtPriceX96 de preço 1:1 (mesmos decimals) → ~1e18', () => {
    // price 1 → sqrtPriceX96 = 1 × 2^96
    const sqrt = Q96;
    const price = uniV3SpotPrice1e18(sqrt, 18, 18);
    // tolerância: ~1e18
    expect(price).toBeGreaterThan(99n * 10n ** 16n); // > 0.99e18
    expect(price).toBeLessThan(101n * 10n ** 16n);   // < 1.01e18
  });

  it('preço 4:1 → sqrtPriceX96 = 2 × 2^96 → price ~4e18', () => {
    // price = (sqrt/2^96)^2 = 2^2 = 4
    const sqrt = 2n * Q96;
    const price = uniV3SpotPrice1e18(sqrt, 18, 18);
    expect(price).toBeGreaterThan(399n * 10n ** 16n); // ~4e18
    expect(price).toBeLessThan(401n * 10n ** 16n);
  });

  it('ajuste de decimals (token0=18, token1=6, tipo WETH/USDC)', () => {
    // Se raw price = 1 (sqrt=2^96), com decimals0=18 decimals1=6:
    // priceHuman = 1 × 10^(18-6) = 1e12 (em escala 1e18 → 1e30)
    const sqrt = Q96;
    const price = uniV3SpotPrice1e18(sqrt, 18, 6);
    expect(price).toBe(10n ** 12n * WAD);
  });

  it('inverso é recíproco do direto', () => {
    const sqrt = 2n * Q96; // price 4
    const direct = uniV3SpotPrice1e18(sqrt, 18, 18);
    const inverse = uniV3SpotPriceInverse1e18(sqrt, 18, 18);
    // direct × inverse ≈ 1e18 × 1e18
    const product = (direct * inverse) / WAD;
    expect(product).toBeGreaterThan(99n * 10n ** 16n);
    expect(product).toBeLessThan(101n * 10n ** 16n);
  });

  it('sqrtPriceX96 zero → 0', () => {
    expect(uniV3SpotPrice1e18(0n, 18, 18)).toBe(0n);
  });
});

describe('Aerodrome volatile pricing (x·y=k)', () => {
  it('reserves iguais → preço 1:1', () => {
    const price = aeroVolatileSpotPrice1e18(1000n * WAD, 1000n * WAD, 18, 18);
    expect(price).toBe(WAD);
  });

  it('reserve1 = 2× reserve0 → preço 2:1', () => {
    const price = aeroVolatileSpotPrice1e18(1000n * WAD, 2000n * WAD, 18, 18);
    expect(price).toBe(2n * WAD);
  });

  it('normaliza decimals diferentes (USDC 6 / WETH 18)', () => {
    // 2000 USDC (6dec) e 1 WETH (18dec): preço WETH-por-USDC = 1/2000
    const price = aeroVolatileSpotPrice1e18(2000n * 10n ** 6n, 1n * WAD, 6, 18);
    // r0=2000e18, r1=1e18 → price = 1e18/2000 = 5e14
    expect(price).toBe(WAD / 2000n);
  });
});

describe('Aerodrome stable pricing (k=x³y+xy³)', () => {
  it('reserves iguais (no peg) → preço ~1', () => {
    const price = aeroStableSpotPrice1e18(1_000_000n * WAD, 1_000_000n * WAD, 18, 18);
    // No peg perfeito, dy/dx = 1
    expect(price).toBeGreaterThan(99n * 10n ** 16n);
    expect(price).toBeLessThan(101n * 10n ** 16n);
  });

  it('stable diverge menos que volatile fora do peg (curva achatada)', () => {
    // Reserves desbalanceadas: stable deve dar preço mais perto de 1 que volatile
    const r0 = 1_200_000n * WAD;
    const r1 = 800_000n * WAD;
    const stable = aeroStableSpotPrice1e18(r0, r1, 18, 18);
    const volatile = aeroVolatileSpotPrice1e18(r0, r1, 18, 18);
    // volatile = 800/1200 = 0.666; stable fica mais perto de 1
    const distStable = stable > WAD ? stable - WAD : WAD - stable;
    const distVolatile = volatile > WAD ? volatile - WAD : WAD - volatile;
    expect(distStable).toBeLessThan(distVolatile);
  });
});

describe('Divergência + direção do arb (núcleo do MIS)', () => {
  it('priceDivergenceBps: 0.5% = 50 bps', () => {
    const a = 2000n * WAD;
    const b = 2010n * WAD; // 0.5% acima
    expect(priceDivergenceBps(a, b)).toBe(50);
  });

  it('priceDivergenceBps: preços iguais = 0', () => {
    expect(priceDivergenceBps(2000n * WAD, 2000n * WAD)).toBe(0);
  });

  it('priceDivergenceBps: preço inválido = 0', () => {
    expect(priceDivergenceBps(0n, 2000n * WAD)).toBe(0);
  });

  it('arbDirection: A mais barato → buyA_sellB', () => {
    expect(arbDirection(2000n * WAD, 2010n * WAD)).toBe('buyA_sellB');
  });

  it('arbDirection: B mais barato → buyB_sellA', () => {
    expect(arbDirection(2010n * WAD, 2000n * WAD)).toBe('buyB_sellA');
  });

  it('arbDirection: iguais → none', () => {
    expect(arbDirection(2000n * WAD, 2000n * WAD)).toBe('none');
  });
});
