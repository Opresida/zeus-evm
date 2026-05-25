/**
 * Aave V3 — builder de calldata pra executeLiquidation.
 *
 * Recebe a decision do calculator + dados da position e constrói:
 *   1. SwapStep[] com router/fee/slippage corretos
 *   2. LiquidationParams struct completo
 *   3. Encoded calldata pronta pra eth_call ou sendTransaction
 */

import { encodeFunctionData, type Address, type Hex, encodeAbiParameters } from 'viem';
import { ZEUS_EXECUTOR_ABI } from '@zeus-evm/strategy';
import { DexType } from '@zeus-evm/dex-adapters';
import type { ChainConfig } from '@zeus-evm/chain-config';

import type { AaveLiquidatablePosition, LiquidationDecision } from '../../types';

export interface BuiltLiquidationTx {
  to: Address;
  data: Hex;
  /** Resumo dos parâmetros pra log/debug */
  summary: {
    borrower: Address;
    flashloanWei: bigint;
    debtAsset: Address;
    collateralAsset: Address;
    swapSteps: number;
  };
}

export interface BuildOpts {
  /** Address do contrato ZeusExecutor na chain ativa */
  executorAddress: Address;
  /** Chain config pra resolver routers DEX */
  chainConfig: ChainConfig;
  /** Address que receberá o profit (geralmente o bot operator wallet) */
  profitReceiver: Address;
  /** Slippage tolerado (bps) — informa minAmountOut do swap */
  slippageBps: number;
  /** Best fee tier UniV3 escolhido pela simulação */
  preferredFeeTier: number;
  /** Expected swap output (em wei do debtAsset) pra aplicar slippage */
  expectedSwapOutput: bigint;
}

/**
 * Constrói a calldata `executeLiquidation` completa.
 * SwapSteps: 1 step single-swap collateral → debtAsset via UniswapV3 SwapRouter02.
 *
 * Pra positions com pool raso, podemos eventualmente adicionar multi-step (cross-DEX),
 * mas pra MVP single-swap cobre 80%+ dos casos com profit positivo.
 */
export function buildLiquidationTx(
  position: AaveLiquidatablePosition,
  decision: LiquidationDecision,
  opts: BuildOpts,
): BuiltLiquidationTx {
  const { executorAddress, chainConfig, profitReceiver, slippageBps, preferredFeeTier, expectedSwapOutput } = opts;

  const swapRouter = chainConfig.uniswapV3.swapRouter02;

  // minAmountOut com slippage protection
  const slippageNumerator = 10_000n - BigInt(slippageBps);
  const minAmountOut = (expectedSwapOutput * slippageNumerator) / 10_000n;

  // extraData = abi.encode(uint24 fee) pro UniswapV3Lib decode
  const extraData = encodeAbiParameters([{ type: 'uint24' }], [preferredFeeTier]);

  const swapSteps = [
    {
      router: swapRouter,
      tokenIn: position.collateralAsset,
      tokenOut: position.debtAsset,
      amountIn: 0n, // 0 = use saldo atual (= collateralReceived após liquidationCall)
      minAmountOut,
      dexType: DexType.UniswapV3 as number,
      extraData,
    },
  ];

  const liquidationParams = {
    user: position.borrower,
    collateralAsset: position.collateralAsset,
    debtAsset: position.debtAsset,
    debtToCover: decision.flashloanAmount,
    swapSteps,
    minProfitWei: decision.minProfitWei,
    profitReceiver,
  };

  const data = encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeLiquidation',
    args: [liquidationParams],
  });

  return {
    to: executorAddress,
    data,
    summary: {
      borrower: position.borrower,
      flashloanWei: decision.flashloanAmount,
      debtAsset: position.debtAsset,
      collateralAsset: position.collateralAsset,
      swapSteps: swapSteps.length,
    },
  };
}
