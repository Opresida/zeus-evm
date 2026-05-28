/**
 * Testes do flash estimator — valida a MATEMÁTICA do flash-arb (empréstimo,
 * devolução com premium 0.05%, lucro bruto/líquido, gas) de forma determinística,
 * com client mockado (sem RPC).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { parseUnits } from 'viem';

import { estimateFlashArb, optimizeFlashLoan } from '../src/flashEstimator';
import type { PoolGroup, InefficiencyObservation } from '@zeus-evm/execution-utils';

const WETH = '0x4200000000000000000000000000000000000006' as Address;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;

// chainConfig mínimo só com o que o estimador usa
const chainConfig = {
  tokens: { WETH, USDC },
  uniswapV3: { quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as Address },
  aerodrome: { router: '0xceeeeee' as Address, factory: '0xfafafa' as Address },
} as any;

const group: PoolGroup = {
  label: 'WETH/USDC',
  tokenA: WETH,
  tokenB: USDC, // quote = USDC (stable → bUsd = 1)
  decimalsA: 18,
  decimalsB: 6,
  pools: [
    { dex: 'univ3', pool: '0xaaa1' as Address, label: 'UniV3-500', fee: 500 },
    { dex: 'univ3', pool: '0xbbb2' as Address, label: 'UniV3-3000', fee: 3000 },
  ],
};

const obs: InefficiencyObservation = {
  groupLabel: 'WETH/USDC',
  timestamp: 1_700_000_000_000,
  maxDivergenceBps: 100,
  cheapPool: 'UniV3-500',
  expensivePool: 'UniV3-3000',
  direction: 'buyA_sellB',
  poolsWithPrice: 2,
};

describe('flashEstimator — math do flash-arb', () => {
  it('lucro líquido = saída − (empréstimo + premium 0.05%) − gas', async () => {
    // buy leg (USDC→WETH no cheap): 10000 USDC → 4 WETH
    // sell leg (WETH→USDC no exp): 4 WETH → 10100 USDC (100 USDC bruto)
    const simulateContract = vi.fn().mockImplementation(({ args }: { args: Array<{ tokenIn: Address }> }) => {
      const tokenIn = args[0]!.tokenIn.toLowerCase();
      const amountOut = tokenIn === USDC.toLowerCase() ? parseUnits('4', 18) : parseUnits('10100', 6);
      return Promise.resolve({ result: [amountOut, 0n, 0, 50_000n] });
    });
    const client = {
      simulateContract,
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      getGasPrice: vi.fn().mockResolvedValue(10_000_000n), // 0.01 gwei → gas desprezível
    } as any;

    const est = await estimateFlashArb({
      client,
      chainConfig,
      group,
      observation: obs,
      opts: { notionalUsd: 10_000, ethUsd: 2500 },
    });

    expect(est).not.toBeNull();
    expect(est!.loanUsd).toBe(10_000);
    // devolução = 10000 + 0.05% = 10005 USDC
    expect(est!.repayUsd).toBeCloseTo(10_005, 1);
    expect(est!.grossProfitUsd).toBeCloseTo(100, 0);
    // líquido ≈ 100 − 5 (premium) − ~0 gas = ~95
    expect(est!.netProfitUsd).toBeGreaterThan(94);
    expect(est!.netProfitUsd).toBeLessThan(95.1);
    expect(est!.profitable).toBe(true);
    expect(est!.profitPct).toBeCloseTo(0.95, 1);
    expect(est!.pair).toBe('WETH/USDC');
    expect(est!.cheapPool).toBe('UniV3-500');
  });

  it('round-trip que perde marca profitable=false', async () => {
    // sell leg devolve só 9900 USDC < empréstimo → prejuízo
    const simulateContract = vi.fn().mockImplementation(({ args }: { args: Array<{ tokenIn: Address }> }) => {
      const tokenIn = args[0]!.tokenIn.toLowerCase();
      const amountOut = tokenIn === USDC.toLowerCase() ? parseUnits('4', 18) : parseUnits('9900', 6);
      return Promise.resolve({ result: [amountOut, 0n, 0, 50_000n] });
    });
    const client = {
      simulateContract,
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      getGasPrice: vi.fn().mockResolvedValue(10_000_000n),
    } as any;

    const est = await estimateFlashArb({
      client, chainConfig, group, observation: obs,
      opts: { notionalUsd: 10_000, ethUsd: 2500 },
    });
    expect(est).not.toBeNull();
    expect(est!.profitable).toBe(false);
    expect(est!.netProfitUsd).toBeLessThan(0);
  });

  it('pool raso (round-trip devolve ~0) → supportsNotional=false', async () => {
    // buy leg ok (10000 USDbC → 4 WETH-eq), mas sell leg só devolve 13 USDbC (slippage devorou)
    const simulateContract = vi.fn().mockImplementation(({ args }: { args: Array<{ tokenIn: Address }> }) => {
      const tokenIn = args[0]!.tokenIn.toLowerCase();
      const amountOut = tokenIn === USDC.toLowerCase() ? parseUnits('4', 18) : parseUnits('13', 6);
      return Promise.resolve({ result: [amountOut, 0n, 0, 50_000n] });
    });
    const client = {
      simulateContract,
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      getGasPrice: vi.fn().mockResolvedValue(10_000_000n),
    } as any;

    const est = await estimateFlashArb({
      client, chainConfig, group, observation: obs,
      opts: { notionalUsd: 10_000, ethUsd: 2500, maxSlippageBps: 500 },
    });
    expect(est).not.toBeNull();
    expect(est!.supportsNotional).toBe(false); // round-trip ~0.13% << 95%
    expect(est!.roundTripRatio).toBeLessThan(0.05);
  });

  it('pool fundo (round-trip ~99%) → supportsNotional=true', async () => {
    // sell leg devolve 9970 USDbC (só fee, sem slippage relevante) → ratio 0.997
    const simulateContract = vi.fn().mockImplementation(({ args }: { args: Array<{ tokenIn: Address }> }) => {
      const tokenIn = args[0]!.tokenIn.toLowerCase();
      const amountOut = tokenIn === USDC.toLowerCase() ? parseUnits('4', 18) : parseUnits('9970', 6);
      return Promise.resolve({ result: [amountOut, 0n, 0, 50_000n] });
    });
    const client = {
      simulateContract,
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      getGasPrice: vi.fn().mockResolvedValue(10_000_000n),
    } as any;

    const est = await estimateFlashArb({
      client, chainConfig, group, observation: obs,
      opts: { notionalUsd: 10_000, ethUsd: 2500, maxSlippageBps: 500 },
    });
    expect(est).not.toBeNull();
    expect(est!.supportsNotional).toBe(true);
    expect(est!.roundTripRatio).toBeCloseTo(0.997, 2);
  });

  it('optimizeFlashLoan acha o pico de lucro e o teto viável (curva côncava)', async () => {
    // Dois pools constant-product com gap de ~1% (cheap price 2000, exp price 2020) e
    // profundidade finita → slippage cresce com o tamanho. Pico de lucro fica em ~$25k.
    const Rusdc = 10_000_000n * 10n ** 6n;  // cheap pool USDC reserve
    const Rweth = 5_000n * 10n ** 18n;       // cheap pool WETH reserve (price 2000)
    const Rusdc2 = 10_100_000n * 10n ** 6n;  // exp pool USDC reserve (price 2020)
    const Rweth2 = 5_000n * 10n ** 18n;

    const cp = (Rin: bigint, Rout: bigint, amountIn: bigint) => (Rout * amountIn) / (Rin + amountIn);
    const simulateContract = vi.fn().mockImplementation(({ args }: { args: Array<{ tokenIn: Address; amountIn: bigint }> }) => {
      const { tokenIn, amountIn } = args[0]!;
      const out = tokenIn.toLowerCase() === USDC.toLowerCase()
        ? cp(Rusdc, Rweth, amountIn)   // buy leg: USDC→WETH no cheap
        : cp(Rweth2, Rusdc2, amountIn); // sell leg: WETH→USDC no exp
      return Promise.resolve({ result: [out, 0n, 0, 50_000n] });
    });
    const client = {
      simulateContract,
      getBlockNumber: vi.fn().mockResolvedValue(1n),
      getGasPrice: vi.fn().mockResolvedValue(10_000_000n),
    } as any;

    const opt = await optimizeFlashLoan({
      client, chainConfig, group, observation: obs,
      opts: { ethUsd: 2000, maxSlippageBps: 500 },
    });

    expect(opt.best).not.toBeNull();
    expect(opt.best!.netProfitUsd).toBeGreaterThan(0);
    // Pico em $25k (lucra mais que $10k, e $50k já vira prejuízo → early-stop)
    expect(opt.best!.loanUsd).toBe(25_000);
    expect(opt.maxViableLoanUsd).toBe(25_000);
    // Curva monotônica subindo até o pico, depois cai
    const peakIdx = opt.curve.findIndex((c) => c.loanUsd === 25_000);
    expect(opt.curve[peakIdx]!.netProfitUsd).toBeGreaterThan(opt.curve[peakIdx - 1]!.netProfitUsd);
  });

  it('retorna null se faltar cheap/expensive pool na observação', async () => {
    const client = { simulateContract: vi.fn(), getBlockNumber: vi.fn(), getGasPrice: vi.fn() } as any;
    const est = await estimateFlashArb({
      client, chainConfig, group,
      observation: { ...obs, cheapPool: undefined, expensivePool: undefined },
      opts: { notionalUsd: 10_000, ethUsd: 2500 },
    });
    expect(est).toBeNull();
  });
});
