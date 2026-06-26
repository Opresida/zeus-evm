/**
 * Fase 2 (cobertura do front) — arbDispatcher emite tx.confirmed / tx.reverted_on_chain.
 * Sem esses eventos, os trades do Motor 2 não entram na tabela de Transações nem no PnL do painel.
 *
 * Mocka @zeus-evm/strategy (gate/flash/build/sim) pra exercitar só o caminho de envio + emit.
 */

import { describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';

vi.mock('@zeus-evm/strategy', () => ({
  filterOpportunity: () => ({ passed: true, netProfitUsd: 12.5 }),
  selectFlashSource: async () => ({ flashSource: 0 }),
  buildFlashloanCalldata: () => '0x',
  simulateArbitrage: async () => ({ success: true, gasUsed: 100_000n }),
}));

import { dispatchArb, type ArbDispatchDeps } from '../src/execution/arbDispatcher';
import type { CrossDexOpportunity } from '@zeus-evm/strategy';

const TKA = '0x1111111111111111111111111111111111111111';
const TKB = '0x2222222222222222222222222222222222222222';

function opp(): CrossDexOpportunity {
  return {
    pair: { id: 'AERO/USDC', tokenA: TKA, tokenB: TKB, decimalsA: 18, decimalsB: 6, category: 'volatile-volatile', estimatedUsdValueA: 1, estimatedUsdValueB: 1, uniswapV3FeeTiers: [500], aerodromeStable: false, aerodromeVolatile: true },
    direction: 'AtoB-BtoA',
    buyQuote: { dex: 1, source: 'UniswapV3 0.05%', tokenIn: TKA, tokenOut: TKB, amountOut: 1000n, extraData: '0x' },
    sellQuote: { dex: 2, source: 'Aerodrome volatile', tokenIn: TKB, tokenOut: TKA, amountOut: 1100n, extraData: '0x' },
    amountIn: 1000n, amountOut: 1100n, profitWei: 100n, profitBps: 1000, profitUsd: 15, blockNumber: 1n, detectedAt: 0,
  } as unknown as CrossDexOpportunity;
}

const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

function makeDeps(receiptStatus: 'success' | 'reverted') {
  const emitted: { type: string; [k: string]: unknown }[] = [];
  const client = {
    getGasPrice: async () => 1n,
    getBlock: async () => null,
    waitForTransactionReceipt: async () => ({
      status: receiptStatus, gasUsed: 100_000n, effectiveGasPrice: 1n, blockNumber: 123n, transactionIndex: 0, logs: [],
    }),
  } as unknown as ArbDispatchDeps['client'];
  const deps: ArbDispatchDeps = {
    mode: 'mainnet', liveExecutionEnabled: true, client,
    wallet: { chain: null, sendTransaction: async () => '0xabc' } as unknown as ArbDispatchDeps['wallet'],
    account: zeroAddress, executorAddress: zeroAddress,
    chainConfig: { name: 'Base' } as never,
    gasOracle: { getFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }) } as never,
    profitReceiver: zeroAddress, ethUsdPrice: 3000, logger: silentLog,
    minProfitUsd: 1, maxSlippageBps: 50, maxTradeWei: 10n ** 30n, estimatedGasUsd: 0.5,
    eventBus: { emit: (e: { type: string }) => emitted.push(e as never) } as never,
  };
  return { deps, emitted };
}

describe('arbDispatcher — eventos tx.* pro painel (Fase 2)', () => {
  it('sucesso → emite tx.confirmed (protocol=arb, pair preenchido)', async () => {
    const { deps, emitted } = makeDeps('success');
    const res = await dispatchArb(opp(), deps);
    expect(res.status).toBe('dispatched');
    const tx = emitted.find((e) => e.type === 'tx.confirmed');
    expect(tx).toBeTruthy();
    expect(tx!.protocol).toBe('arb');
    expect(tx!.pair).toBe('AERO/USDC');
    expect(tx!.txHash).toBe('0xabc');
  });

  it('revert → emite tx.reverted_on_chain (protocol=arb)', async () => {
    const { deps, emitted } = makeDeps('reverted');
    const res = await dispatchArb(opp(), deps);
    expect(res.status).toBe('reverted_on_chain');
    const tx = emitted.find((e) => e.type === 'tx.reverted_on_chain');
    expect(tx).toBeTruthy();
    expect(tx!.protocol).toBe('arb');
    expect(tx!.pair).toBe('AERO/USDC');
  });
});
