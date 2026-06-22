/**
 * Fase 3 — seletor de flashloan no arb/backrun (antes forçava Aave 0,05%).
 * Cobre a decisão pura (Morpho/Balancer 0% > Aave) + o encoding do flashSource no calldata.
 */

import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { DexType } from '@zeus-evm/dex-adapters';
import { pickFlashSourceByLiquidity, FLASH_SOURCE } from '../src/executor/flashSourceSelector';
import { buildBackrunCalldata, NO_BRIBE, buildFlashloanCalldata } from '../src/executor/txBuilder';

const quote = (dex: number) => ({
  dex, tokenIn: zeroAddress, tokenOut: zeroAddress, amountOut: 1000n, extraData: '0x' as `0x${string}`,
});
const opp = {
  pair: { id: 'A/B', tokenA: zeroAddress, tokenB: zeroAddress, feeTier: 500 },
  direction: 'AtoB-BtoA' as const,
  buyQuote: quote(DexType.UniswapV3),
  sellQuote: quote(DexType.Aerodrome),
  amountIn: 1000n,
  amountOut: 1010n,
  profitWei: 10n,
  profitBps: 100,
  profitUsd: 1,
  blockNumber: 1n,
  detectedAt: 0,
} as unknown as Parameters<typeof buildBackrunCalldata>[0]['opp'];

describe('pickFlashSourceByLiquidity (Fase 3)', () => {
  it('escolhe Morpho quando tem liquidez (0%)', () => {
    const sel = pickFlashSourceByLiquidity(1000n, { morpho: 100_000n, balancer: 0n });
    expect(sel.flashSource).toBe(FLASH_SOURCE.Morpho);
    expect(sel.flashPremiumBps).toBe(0n);
  });

  it('cai pra Balancer quando Morpho seco (ainda 0%)', () => {
    const sel = pickFlashSourceByLiquidity(1000n, { morpho: 500n, balancer: 100_000n });
    expect(sel.flashSource).toBe(FLASH_SOURCE.Balancer);
    expect(sel.flashPremiumBps).toBe(0n);
  });

  it('fallback Aave (0,05%) quando nenhuma fonte 0% cobre com folga', () => {
    const sel = pickFlashSourceByLiquidity(1000n, { morpho: 1000n, balancer: 1005n }); // < 1% buffer
    expect(sel.flashSource).toBe(FLASH_SOURCE.Aave);
    expect(sel.flashPremiumBps).toBe(5n);
  });
});

describe('builders encodam o flashSource selecionado', () => {
  it('buildBackrunCalldata usa o flashSource passado (Morpho=1), diferente do default Aave=0', () => {
    const withMorpho = buildBackrunCalldata({ opp, profitReceiver: zeroAddress, flashloanAsset: zeroAddress, flashloanAmount: 1000n, bribe: NO_BRIBE, flashSource: FLASH_SOURCE.Morpho });
    const withAave = buildBackrunCalldata({ opp, profitReceiver: zeroAddress, flashloanAsset: zeroAddress, flashloanAmount: 1000n, bribe: NO_BRIBE });
    expect(withMorpho).not.toBe(withAave); // o campo flashSource muda o calldata encodado
  });

  it('buildFlashloanCalldata aceita flashSource (Balancer=2)', () => {
    const data = buildFlashloanCalldata({ opp, profitReceiver: zeroAddress, flashloanAsset: zeroAddress, flashloanAmount: 1000n, flashSource: FLASH_SOURCE.Balancer });
    expect(data.startsWith('0x')).toBe(true);
  });
});
