/**
 * Testes da decisão pura do seletor de fonte de flashloan.
 * Valida a prioridade econômica Morpho (0%) → Balancer (0%) → Aave (0,05%)
 * e a margem de segurança de liquidez (bufferBps).
 */

import { describe, it, expect } from 'vitest';
import { pickFlashSourceByLiquidity } from '../src/flashSourceSelector';
import { FlashSource } from '../src/types';

const AMOUNT = 100_000n * 10n ** 6n; // 100k USDC (6 casas)

describe('pickFlashSourceByLiquidity', () => {
  it('escolhe Morpho (0%) quando há liquidez de sobra', () => {
    const sel = pickFlashSourceByLiquidity(AMOUNT, { morpho: AMOUNT * 10n, balancer: AMOUNT * 10n });
    expect(sel.flashSource).toBe(FlashSource.Morpho);
    expect(sel.flashPremiumBps).toBe(0n);
  });

  it('prefere Morpho sobre Balancer quando ambos têm liquidez', () => {
    const sel = pickFlashSourceByLiquidity(AMOUNT, { morpho: AMOUNT * 2n, balancer: AMOUNT * 100n });
    expect(sel.flashSource).toBe(FlashSource.Morpho);
  });

  it('cai pro Balancer (0%) quando Morpho não tem liquidez suficiente', () => {
    const sel = pickFlashSourceByLiquidity(AMOUNT, { morpho: AMOUNT / 2n, balancer: AMOUNT * 5n });
    expect(sel.flashSource).toBe(FlashSource.Balancer);
    expect(sel.flashPremiumBps).toBe(0n);
  });

  it('cai pro fallback Aave (0,05%) quando nenhuma fonte 0% cobre o empréstimo', () => {
    const sel = pickFlashSourceByLiquidity(AMOUNT, { morpho: 0n, balancer: AMOUNT / 2n });
    expect(sel.flashSource).toBe(FlashSource.Aave);
    expect(sel.flashPremiumBps).toBe(5n);
  });

  it('respeita a margem de segurança: liquidez exatamente igual ao amount NÃO basta (precisa cobrir buffer)', () => {
    // morpho == amount exato; com buffer de 1% o required > amount → Morpho rejeitado
    const sel = pickFlashSourceByLiquidity(AMOUNT, { morpho: AMOUNT, balancer: 0n });
    expect(sel.flashSource).toBe(FlashSource.Aave);
  });

  it('aceita Morpho quando a liquidez cobre amount + buffer', () => {
    const withBuffer = (AMOUNT * 10_100n) / 10_000n; // +1%
    const sel = pickFlashSourceByLiquidity(AMOUNT, { morpho: withBuffer, balancer: 0n });
    expect(sel.flashSource).toBe(FlashSource.Morpho);
  });

  it('buffer customizado (0) aceita liquidez exatamente igual ao amount', () => {
    const sel = pickFlashSourceByLiquidity(AMOUNT, { morpho: AMOUNT, balancer: 0n }, 0n);
    expect(sel.flashSource).toBe(FlashSource.Morpho);
  });
});
