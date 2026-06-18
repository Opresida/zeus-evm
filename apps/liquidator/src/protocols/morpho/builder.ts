/**
 * Morpho Blue — builder de calldata pra executeMorphoLiquidation.
 *
 * Monta MorphoLiquidationParams: marketParams (5 campos) + borrower +
 * seizedAssets/repaidShares (do plano) + flashloan + swapSteps (collateral→loan).
 */

import { encodeFunctionData, encodeAbiParameters, type Address, type Hex } from 'viem';
import { ZEUS_EXECUTOR_ABI, type BribeConfig } from '@zeus-evm/strategy';
import { DexType } from '@zeus-evm/dex-adapters';
import type { ChainConfig } from '@zeus-evm/chain-config';

import type { MorphoLiquidatablePosition, LiquidationDecision } from '../../types';
import type { LiquidationPlan } from './math';

export interface BuiltMorphoLiquidationTx {
  to: Address;
  data: Hex;
  summary: {
    marketId: `0x${string}`;
    borrower: Address;
    mode: LiquidationPlan['mode'];
    loanToken: Address;
    collateralToken: Address;
    flashloanWei: bigint;
    swapSteps: number;
    withBribe: boolean;
  };
}

export interface BuildMorphoOpts {
  executorAddress: Address;
  morpho: Address;
  chainConfig: ChainConfig;
  profitReceiver: Address;
  slippageBps: number;
  preferredFeeTier: number;
  /** Expected swap output em wei do loanToken (pra slippage no swapStep). */
  expectedSwapOutput: bigint;
  /**
   * Bribe opcional. Quando presente, a tx vai pela função `executeMorphoLiquidationWithBribe`
   * (paga "gorjeta" pro validador pra ganhar a corrida de inclusão). Quando ausente, usa o
   * caminho puro `executeMorphoLiquidation`. Essa variante voltou no split v8 do contrato —
   * é a mais importante pra nós, já que Morpho é o edge aberto onde a briga é latência/bots.
   */
  bribe?: BribeConfig;
}

export function buildMorphoLiquidationTx(
  position: MorphoLiquidatablePosition,
  decision: LiquidationDecision,
  plan: LiquidationPlan,
  opts: BuildMorphoOpts,
): BuiltMorphoLiquidationTx {
  const { executorAddress, morpho, chainConfig, profitReceiver, slippageBps, preferredFeeTier, expectedSwapOutput, bribe } = opts;

  const swapRouter = chainConfig.uniswapV3.swapRouter02;
  const minAmountOut = (expectedSwapOutput * (10_000n - BigInt(slippageBps))) / 10_000n;
  const extraData = encodeAbiParameters([{ type: 'uint24' }], [preferredFeeTier]);

  const swapSteps = [
    {
      router: swapRouter,
      tokenIn: position.collateralToken,
      tokenOut: position.loanToken,
      amountIn: 0n, // 0 = usa saldo (colateral seizado pós-liquidate)
      minAmountOut,
      dexType: DexType.UniswapV3 as number,
      extraData,
    },
  ];

  const morphoParams = {
    morpho,
    loanToken: position.loanToken,
    collateralToken: position.collateralToken,
    oracle: position.oracle,
    irm: position.irm,
    lltv: position.lltv,
    borrower: position.borrower,
    seizedAssets: plan.seizedAssets,
    repaidShares: plan.repaidShares,
    flashloanAmount: decision.flashloanAmount,
    swapSteps,
    minProfitWei: decision.minProfitWei,
    profitReceiver,
    flashSource: decision.flashSource as number,
  };

  // Com bribe → função WithBribe (args = [params, bribe]); sem bribe → função pura (args = [params]).
  const data = bribe
    ? encodeFunctionData({
        abi: ZEUS_EXECUTOR_ABI,
        functionName: 'executeMorphoLiquidationWithBribe',
        args: [morphoParams, bribe],
      })
    : encodeFunctionData({
        abi: ZEUS_EXECUTOR_ABI,
        functionName: 'executeMorphoLiquidation',
        args: [morphoParams],
      });

  return {
    to: executorAddress,
    data,
    summary: {
      marketId: position.marketId,
      borrower: position.borrower,
      mode: plan.mode,
      loanToken: position.loanToken,
      collateralToken: position.collateralToken,
      flashloanWei: decision.flashloanAmount,
      swapSteps: swapSteps.length,
      withBribe: Boolean(bribe),
    },
  };
}
