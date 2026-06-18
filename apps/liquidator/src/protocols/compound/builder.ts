/**
 * Compound III — builder de calldata pra executeCompoundLiquidation.
 *
 * Diferente do Aave que tem `LiquidationParams.debtToCover` como input principal,
 * Compound usa `CompoundLiquidationParams.baseAmount` (quanto base token vai gastar
 * em buyCollateral). O contrato faz absorb + buyCollateral + swap + repay atomicamente.
 */

import { encodeFunctionData, type Address, type Hex, encodeAbiParameters } from 'viem';
import { ZEUS_EXECUTOR_ABI, type BribeConfig } from '@zeus-evm/strategy';
import { DexType } from '@zeus-evm/dex-adapters';
import type { ChainConfig } from '@zeus-evm/chain-config';

import type { CompoundLiquidatablePosition, LiquidationDecision } from '../../types';

export interface BuiltCompoundLiquidationTx {
  to: Address;
  data: Hex;
  summary: {
    cometName: string;
    borrower: Address;
    baseAmountWei: bigint;
    baseToken: Address;
    collateralAsset: Address;
    swapSteps: number;
    withBribe: boolean;
  };
}

export interface BuildCompoundOpts {
  executorAddress: Address;
  chainConfig: ChainConfig;
  profitReceiver: Address;
  slippageBps: number;
  preferredFeeTier: number;
  /** Expected swap output em wei do baseToken (pra aplicar slippage no swapStep). */
  expectedSwapOutput: bigint;
  /** minCollateralReceived: proteção on-chain durante buyCollateral (~95% do esperado). */
  minCollateralReceivedWei: bigint;
  /**
   * Bribe opcional. Quando presente, a tx vai pela função `executeCompoundLiquidationWithBribe`
   * (paga um "gorjeta" pro validador pra ganhar a corrida de inclusão). Quando ausente, usa o
   * caminho puro `executeCompoundLiquidation`. A função WithBribe voltou no split v8 do contrato
   * (tinha sido cortada na v7.1 por limite de bytecode).
   */
  bribe?: BribeConfig;
}

export function buildCompoundLiquidationTx(
  position: CompoundLiquidatablePosition,
  decision: LiquidationDecision,
  opts: BuildCompoundOpts,
): BuiltCompoundLiquidationTx {
  const {
    executorAddress,
    chainConfig,
    profitReceiver,
    slippageBps,
    preferredFeeTier,
    expectedSwapOutput,
    minCollateralReceivedWei,
    bribe,
  } = opts;

  const swapRouter = chainConfig.uniswapV3.swapRouter02;

  // minAmountOut do swap (collateral → baseToken)
  const slippageNumerator = 10_000n - BigInt(slippageBps);
  const minAmountOut = (expectedSwapOutput * slippageNumerator) / 10_000n;

  // extraData = abi.encode(uint24 fee)
  const extraData = encodeAbiParameters([{ type: 'uint24' }], [preferredFeeTier]);

  const swapSteps = [
    {
      router: swapRouter,
      tokenIn: position.collateralAsset,
      tokenOut: position.baseToken,
      amountIn: 0n, // 0 = use saldo atual (= collateral comprado pós buyCollateral)
      minAmountOut,
      dexType: DexType.UniswapV3 as number,
      extraData,
    },
  ];

  const compoundParams = {
    comet: position.comet,
    borrower: position.borrower,
    collateralAsset: position.collateralAsset,
    baseAmount: decision.flashloanAmount,
    minCollateralReceived: minCollateralReceivedWei,
    swapSteps,
    minProfitWei: decision.minProfitWei,
    profitReceiver,
    flashSource: decision.flashSource as number,
  };

  // Com bribe → função WithBribe (args = [params, bribe]); sem bribe → função pura (args = [params]).
  const data = bribe
    ? encodeFunctionData({
        abi: ZEUS_EXECUTOR_ABI,
        functionName: 'executeCompoundLiquidationWithBribe',
        args: [compoundParams, bribe],
      })
    : encodeFunctionData({
        abi: ZEUS_EXECUTOR_ABI,
        functionName: 'executeCompoundLiquidation',
        args: [compoundParams],
      });

  return {
    to: executorAddress,
    data,
    summary: {
      cometName: position.cometName,
      borrower: position.borrower,
      baseAmountWei: decision.flashloanAmount,
      baseToken: position.baseToken,
      collateralAsset: position.collateralAsset,
      swapSteps: swapSteps.length,
      withBribe: Boolean(bribe),
    },
  };
}
