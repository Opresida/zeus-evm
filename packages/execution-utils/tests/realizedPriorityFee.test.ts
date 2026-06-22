/**
 * Fase 4 (M1) — priority fee REAL = effectiveGasPrice − baseFee (não o gas price cheio).
 */

import { describe, expect, it } from 'vitest';
import { realizedPriorityFeeWei } from '../src/priceUtils';

describe('realizedPriorityFeeWei (M1)', () => {
  it('subtrai a baseFee do effectiveGasPrice', () => {
    expect(realizedPriorityFeeWei(1_000n, 900n)).toBe(100n); // só os 100 de priority
  });

  it('clampa em 0 quando effectiveGasPrice <= baseFee', () => {
    expect(realizedPriorityFeeWei(900n, 1_000n)).toBe(0n);
  });

  it('undefined quando falta algum dado (reconciler ignora o sub-métrico)', () => {
    expect(realizedPriorityFeeWei(undefined, 900n)).toBeUndefined();
    expect(realizedPriorityFeeWei(1_000n, null)).toBeUndefined();
  });
});
