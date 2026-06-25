/**
 * Swap dinâmico multi-DEX no Motor 1 — o builder deve montar o SwapStep a partir do `swapPlan`
 * escolhido pelo calculator (UniV3/Aero/Slipstream), com fallback UniV3 quando ausente.
 * Teste PURO (decodifica a calldata; sem rede).
 */

import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, type Address, type Hex } from 'viem';
import { BASE_MAINNET } from '@zeus-evm/chain-config';
import { DexType } from '@zeus-evm/dex-adapters';
import { ZEUS_EXECUTOR_ABI } from '@zeus-evm/strategy';
import { buildLiquidationTx } from '../src/protocols/aave/builder';
import { FlashSource, type LiquidationDecision, type SwapPlan } from '../src/types';

const WETH = '0x4200000000000000000000000000000000000006' as Address;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const EXECUTOR = '0x1111111111111111111111111111111111111111' as Address;
const RECEIVER = '0x2222222222222222222222222222222222222222' as Address;

const position = {
  borrower: '0x3333333333333333333333333333333333333333' as Address,
  collateralAsset: WETH,
  debtAsset: USDC,
} as never;

function baseDecision(swapPlan?: SwapPlan): LiquidationDecision {
  return {
    flashloanAmount: 1000n * 10n ** 6n,
    expectedProfitWei: 10n * 10n ** 6n,
    expectedProfitUsd: 10,
    estimatedSlippageBps: 20,
    minProfitWei: 7n * 10n ** 6n,
    flashSource: FlashSource.Aave,
    flashPremiumBps: 5n,
    swapPlan,
  };
}

/** Decodifica a calldata e devolve o 1º SwapStep. */
function firstSwapStep(data: Hex) {
  const { args } = decodeFunctionData({ abi: ZEUS_EXECUTOR_ABI, data });
  const params = (args as readonly unknown[])[0] as { swapSteps: readonly { router: Address; dexType: number; extraData: Hex }[] };
  return params.swapSteps[0]!;
}

const opts = {
  executorAddress: EXECUTOR,
  chainConfig: BASE_MAINNET,
  profitReceiver: RECEIVER,
  slippageBps: 50,
  preferredFeeTier: 500,
  expectedSwapOutput: 1010n * 10n ** 6n,
};

describe('Motor 1 — swap multi-DEX no builder', () => {
  it('SEM swapPlan → fallback UniswapV3 (router canônico + fee tier)', () => {
    const tx = buildLiquidationTx(position, baseDecision(), opts);
    const step = firstSwapStep(tx.data);
    expect(step.dexType).toBe(DexType.UniswapV3);
    expect(step.router.toLowerCase()).toBe(BASE_MAINNET.uniswapV3.swapRouter02.toLowerCase());
  });

  it('COM swapPlan (Slipstream) → usa router/dexType/extraData do plano', () => {
    const slipRouter = BASE_MAINNET.slipstream!.swapRouter;
    const extraData = encodeAbiParameters([{ type: 'int24' }], [100]);
    const plan: SwapPlan = {
      dexType: DexType.Slipstream,
      router: slipRouter,
      extraData,
      expectedOutput: 1020n * 10n ** 6n,
    };
    const tx = buildLiquidationTx(position, baseDecision(plan), opts);
    const step = firstSwapStep(tx.data);
    expect(step.dexType).toBe(DexType.Slipstream);
    expect(step.router.toLowerCase()).toBe(slipRouter.toLowerCase());
    expect(step.extraData).toBe(extraData);
  });
});
