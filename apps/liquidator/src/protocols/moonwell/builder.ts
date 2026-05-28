/**
 * Moonwell — builder de calldata pra executeMoonwellLiquidation.
 * Tx vai pro ZeusMoonwellLiquidator (contrato SEPARADO, endereço próprio).
 */

import { encodeFunctionData, encodeAbiParameters, type Address, type Hex } from 'viem';
import { DexType } from '@zeus-evm/dex-adapters';
import type { ChainConfig } from '@zeus-evm/chain-config';

import type { MoonwellLiquidatablePosition, LiquidationDecision } from '../../types';
import { ZEUS_MOONWELL_LIQUIDATOR_ABI } from './abi';

export interface BuiltMoonwellLiquidationTx {
  to: Address;
  data: Hex;
  summary: {
    borrower: Address;
    mTokenBorrowed: Address;
    mTokenCollateral: Address;
    borrowedUnderlying: Address;
    collateralUnderlying: Address;
    repayAmountWei: bigint;
    swapSteps: number;
  };
}

export interface BuildMoonwellOpts {
  /** Endereço do ZeusMoonwellLiquidator (contrato separado). */
  moonwellLiquidatorAddress: Address;
  chainConfig: ChainConfig;
  profitReceiver: Address;
  slippageBps: number;
  preferredFeeTier: number;
  /** Output esperado do swap collateral→borrowed (pra slippage no swapStep). */
  expectedSwapOutput: bigint;
}

export function buildMoonwellLiquidationTx(
  position: MoonwellLiquidatablePosition,
  decision: LiquidationDecision,
  opts: BuildMoonwellOpts,
): BuiltMoonwellLiquidationTx {
  const { moonwellLiquidatorAddress, chainConfig, profitReceiver, slippageBps, preferredFeeTier, expectedSwapOutput } = opts;

  const swapRouter = chainConfig.uniswapV3.swapRouter02;
  const minAmountOut = (expectedSwapOutput * (10_000n - BigInt(slippageBps))) / 10_000n;
  const extraData = encodeAbiParameters([{ type: 'uint24' }], [preferredFeeTier]);

  const swapSteps = [
    {
      router: swapRouter,
      tokenIn: position.collateralUnderlying,
      tokenOut: position.borrowedUnderlying,
      amountIn: 0n, // 0 = usa saldo (colateral redeemed pós-liquidateBorrow)
      minAmountOut,
      dexType: DexType.UniswapV3 as number,
      extraData,
    },
  ];

  const params = {
    mTokenBorrowed: position.mTokenBorrowed,
    borrowedUnderlying: position.borrowedUnderlying,
    mTokenCollateral: position.mTokenCollateral,
    collateralUnderlying: position.collateralUnderlying,
    borrower: position.borrower,
    repayAmount: decision.flashloanAmount,
    flashloanAmount: decision.flashloanAmount,
    swapSteps,
    minProfitWei: decision.minProfitWei,
    profitReceiver,
  };

  const data = encodeFunctionData({
    abi: ZEUS_MOONWELL_LIQUIDATOR_ABI,
    functionName: 'executeMoonwellLiquidation',
    args: [params],
  });

  return {
    to: moonwellLiquidatorAddress,
    data,
    summary: {
      borrower: position.borrower,
      mTokenBorrowed: position.mTokenBorrowed,
      mTokenCollateral: position.mTokenCollateral,
      borrowedUnderlying: position.borrowedUnderlying,
      collateralUnderlying: position.collateralUnderlying,
      repayAmountWei: decision.flashloanAmount,
      swapSteps: swapSteps.length,
    },
  };
}
