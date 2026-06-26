/**
 * Paridade defensiva do Motor 2 (reuso cross-motor do que o Motor 1 já tem):
 *  - Gate de auto-pause (saúde/reorg) ANTES de simular/enviar (fail-safe).
 *  - LatencyTracker.observe no caminho de envio real (p50/p95 pro heartbeat).
 *  - TxStateMachine + OrphanRecoveryManager registram a submissão (recovery de órfã pós-reorg).
 *
 * Mocka @zeus-evm/strategy (gate/flash/build/sim) pra exercitar só o caminho de dispatch.
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

function baseDeps(): ArbDispatchDeps {
  const client = {
    getGasPrice: async () => 1n,
    getBlock: async () => null,
    call: async () => '0x',
    waitForTransactionReceipt: async () => ({
      status: 'success', gasUsed: 100_000n, effectiveGasPrice: 1n, blockNumber: 123n, blockHash: '0xfeed', transactionIndex: 0, logs: [],
    }),
  } as unknown as ArbDispatchDeps['client'];
  return {
    mode: 'mainnet', liveExecutionEnabled: true, client,
    wallet: { chain: null, sendTransaction: async () => '0xabc' } as unknown as ArbDispatchDeps['wallet'],
    account: zeroAddress, executorAddress: zeroAddress,
    chainConfig: { name: 'Base' } as never,
    gasOracle: { getFees: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, baseFeePerGas: 0n }) } as never,
    profitReceiver: zeroAddress, ethUsdPrice: 3000, logger: silentLog,
    minProfitUsd: 1, maxSlippageBps: 50, maxTradeWei: 10n ** 30n, estimatedGasUsd: 0.5,
  };
}

describe('arbDispatcher — paridade defensiva (Motor 2)', () => {
  it('gate de auto-pause: se shouldPause()===true, NÃO envia (rejected: auto_paused)', async () => {
    const deps = baseDeps();
    let sent = false;
    deps.wallet = { chain: null, sendTransaction: async () => { sent = true; return '0xabc'; } } as never;
    deps.autoPauseManager = { shouldPause: () => true, summary: () => 'reorg depth=4' } as never;

    const res = await dispatchArb(opp(), deps);
    expect(res.status).toBe('rejected');
    expect(res.reason).toMatch(/^auto_paused: reorg depth=4/);
    expect(sent).toBe(false); // nunca chegou a enviar
  });

  it('auto-pause liberado: envia normalmente (dispatched)', async () => {
    const deps = baseDeps();
    deps.autoPauseManager = { shouldPause: () => false, summary: () => '' } as never;
    const res = await dispatchArb(opp(), deps);
    expect(res.status).toBe('dispatched');
  });

  it('caminho de envio: registra tx-state + orphan + latência (recovery pós-reorg + p50/p95)', async () => {
    const deps = baseDeps();
    const calls = { recordSubmitted: 0, recordIncluded: 0, registerSubmission: 0, observe: 0 };
    deps.txStateMachine = {
      recordSubmitted: () => { calls.recordSubmitted++; return {} as never; },
      recordIncluded: () => { calls.recordIncluded++; return {} as never; },
    } as never;
    deps.orphanRecoveryManager = { registerSubmission: () => { calls.registerSubmission++; } } as never;
    deps.latencyTracker = { observe: () => { calls.observe++; } } as never;

    const res = await dispatchArb(opp(), deps);
    expect(res.status).toBe('dispatched');
    expect(calls.recordSubmitted).toBe(1);
    expect(calls.registerSubmission).toBe(1);
    expect(calls.recordIncluded).toBe(1);
    expect(calls.observe).toBe(1);
  });

  it('sem as deps defensivas: comportamento inalterado (zero regressão)', async () => {
    const deps = baseDeps(); // nenhuma dep defensiva setada
    const res = await dispatchArb(opp(), deps);
    expect(res.status).toBe('dispatched');
  });
});
