/**
 * Parte A — execução de arb do Motor 2.
 * Cobre o adaptador PoolGroup→TargetPair e o gate de EV do dispatcher (reject sem tocar RPC).
 */

import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import type { PoolGroup } from '@zeus-evm/execution-utils';
import type { CrossDexOpportunity } from '@zeus-evm/strategy';
import { groupToTargetPair } from '../src/execution/arbOpportunity';
import { dispatchArb, type ArbDispatchDeps } from '../src/execution/arbDispatcher';

const TKA = '0x1111111111111111111111111111111111111111';
const TKB = '0x2222222222222222222222222222222222222222';

const group: PoolGroup = {
  label: 'TKA/TKB', tokenA: TKA, tokenB: TKB, decimalsA: 18, decimalsB: 6,
  pools: [
    { dex: 'univ3', pool: zeroAddress, label: 'UniV3-500', fee: 500 },
    { dex: 'univ3', pool: zeroAddress, label: 'UniV3-3000', fee: 3000 },
    { dex: 'aerodrome', pool: zeroAddress, label: 'Aero-volatile', stable: false },
  ],
};

const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

function opp(profitUsd: number, amountIn = 1000n): CrossDexOpportunity {
  return {
    pair: { id: 'TKA/TKB', tokenA: TKA, tokenB: TKB, decimalsA: 18, decimalsB: 6, category: 'volatile-volatile', estimatedUsdValueA: 1, estimatedUsdValueB: 1, uniswapV3FeeTiers: [500], aerodromeStable: false, aerodromeVolatile: true },
    direction: 'AtoB-BtoA',
    buyQuote: { dex: 0, tokenIn: TKA, tokenOut: TKB, amountOut: 1000n, extraData: '0x' } as any,
    sellQuote: { dex: 1, tokenIn: TKB, tokenOut: TKA, amountOut: 1100n, extraData: '0x' } as any,
    amountIn, amountOut: 1100n, profitWei: 100n, profitBps: 1000, profitUsd,
    blockNumber: 1n, detectedAt: 0,
  } as unknown as CrossDexOpportunity;
}

// Client que EXPLODE se tocado — prova que o reject por EV não faz RPC.
const explodingClient = new Proxy({}, { get() { throw new Error('RPC não deveria ser chamado no reject por EV'); } }) as any;

function deps(): ArbDispatchDeps {
  return {
    mode: 'dryrun', client: explodingClient, chainConfig: { name: 'Base' } as any,
    gasOracle: {} as any, profitReceiver: zeroAddress, ethUsdPrice: 3000, logger: silentLog,
    minProfitUsd: 5, maxSlippageBps: 50, maxTradeWei: 10_000n, estimatedGasUsd: 0.5,
  };
}

describe('groupToTargetPair (Parte A)', () => {
  it('mapeia fee tiers UniV3 + flags Aerodrome dos pools reais', () => {
    const tp = groupToTargetPair(group, 1, 1);
    expect(tp.id).toBe('TKA/TKB');
    expect([...tp.uniswapV3FeeTiers].sort((a, b) => a - b)).toEqual([500, 3000]);
    expect(tp.aerodromeVolatile).toBe(true);
    expect(tp.aerodromeStable).toBe(false);
  });
});

describe('dispatchArb — gate de EV (Parte A)', () => {
  it('rejeita lucro abaixo do mínimo SEM tocar RPC', async () => {
    const res = await dispatchArb(opp(0.5), deps()); // profit $0.50 < min $5
    expect(res.status).toBe('rejected');
    expect(res.reason).toMatch(/net profit/);
  });

  it('rejeita amountIn acima do cap de trade SEM tocar RPC', async () => {
    const res = await dispatchArb(opp(100, 99_999n), deps()); // amountIn > maxTradeWei 10_000
    expect(res.status).toBe('rejected');
    expect(res.reason).toMatch(/maxTradeWei/);
  });
});
