/**
 * #5 automação — calibração de slippage por DEX (seed do Dune 7860473).
 * Prova: mapeia rótulos internos → DEX certo, respeita as faixas de tamanho, e a rota soma as 2 pernas.
 */

import { describe, expect, it } from 'vitest';
import { slippageBpsFor, routeSlippageBps, normalizeDexKey, sizeBucketFor, effectiveMaxSlippageBps } from '../src/scoring/slippageCalibration';

describe('slippageCalibration (#5)', () => {
  it('normaliza rótulos internos pro DEX certo', () => {
    expect(normalizeDexKey('Aerodrome volatile')).toBe('aerodrome-volatile');
    expect(normalizeDexKey('Slipstream')).toBe('aerodrome-slipstream');
    expect(normalizeDexKey('Aero CL 200')).toBe('aerodrome-slipstream');
    expect(normalizeDexKey('UniV3 0.3%')).toBe('uniswap-v3');
    expect(normalizeDexKey('Uniswap V4')).toBe('uniswap-v4');
    expect(normalizeDexKey('PancakeV3')).toBe('pancake-v3');
    expect(normalizeDexKey('AlienBase')).toBe('alienbase');
    expect(normalizeDexKey('BaseSwap V2')).toBe('uniswap-v2');
    expect(normalizeDexKey('algum-dex-novo')).toBe('unknown');
  });

  it('faixas de tamanho corretas', () => {
    expect(sizeBucketFor(500)).toBe(0);
    expect(sizeBucketFor(3000)).toBe(1);
    expect(sizeBucketFor(10000)).toBe(2);
    expect(sizeBucketFor(50000)).toBe(3);
    expect(sizeBucketFor(500000)).toBe(4);
  });

  it('reflete a realidade do Dune: Aerodrome volátil >> Slipstream (o global 50bps é apertado)', () => {
    // Slipstream é tight; volátil é largo — a razão de existir do #5.
    expect(slippageBpsFor('Slipstream', 3000)).toBeLessThan(slippageBpsFor('Aerodrome volatile', 3000));
    // Ambos ACIMA do 50 global → o global rejeitaria trades bons.
    expect(slippageBpsFor('Slipstream', 3000)).toBeGreaterThan(50);
    // DEX desconhecido cai no conservador.
    expect(slippageBpsFor('dex-fantasma', 3000)).toBe(130);
  });

  it('rota de arb soma as duas pernas', () => {
    const buy = slippageBpsFor('UniV3 0.3%', 10000);
    const sell = slippageBpsFor('Aerodrome volatile', 10000);
    expect(routeSlippageBps('UniV3 0.3%', 'Aerodrome volatile', 10000)).toBe(buy + sell);
  });

  it('helper compartilhado (M1+M2): observe-first + 1 perna (M1) vs 2 pernas (M2)', () => {
    // observe-first: desligado → devolve o GLOBAL (sem regressão nos 2 motores).
    expect(effectiveMaxSlippageBps({ dexLabel: 'Slipstream', globalBps: 50, perDexEnabled: false })).toBe(50);
    // M1 (1 perna): venda do colateral → só o DEX de venda.
    expect(effectiveMaxSlippageBps({ dexLabel: 'Slipstream', globalBps: 50, perDexEnabled: true, notionalUsd: 3000 }))
      .toBe(slippageBpsFor('Slipstream', 3000));
    // M2 (2 pernas): round-trip → soma buy+sell.
    expect(effectiveMaxSlippageBps({ dexLabel: 'UniV3', secondDexLabel: 'Aerodrome volatile', globalBps: 50, perDexEnabled: true, notionalUsd: 3000 }))
      .toBe(routeSlippageBps('UniV3', 'Aerodrome volatile', 3000));
  });
});
