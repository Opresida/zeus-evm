/**
 * Morpho PRE-liquidation — builder de calldata pra executePreMorphoLiquidation.
 *
 * Monta PreMorphoLiquidationParams (struct ENXUTA do nosso ZeusMorphoPreLiquidator — SEM
 * flashloan/oracle/irm/lltv): preLiquidation + loan/collateral + borrower + seizedAssets/repaidShares
 * (do plano) + swapSteps (collateral → loanToken) + minProfitWei + profitReceiver.
 *
 * Modo por-shares (espelha o plano): seizedAssets = 0, repaidShares = plan.repaidShares.
 * swapStep único usando o `quote` (router/dexType/extraData já resolvidos), amountIn = 0 (usa o
 * colateral seizado que o callback deixou no contrato). minAmountOut aplica slippage sobre o expected.
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';
import type { Quote } from '@zeus-evm/dex-adapters';

import { ZEUS_MORPHO_PRELIQUIDATOR_ABI } from './abi';
import type { PrePosition } from './types';
import type { PrePlan } from './math';

export interface BuiltPreLiquidationTx {
  to: Address;
  data: Hex;
  summary: {
    marketId: `0x${string}`;
    preLiquidation: Address;
    borrower: Address;
    loanToken: Address;
    collateralToken: Address;
    repaidShares: bigint;
    seizedAssets: bigint;
    swapSteps: number;
    minProfitWei: bigint;
  };
}

export interface BuildPreLiquidationOpts {
  /** Nosso ZeusMorphoPreLiquidator (alvo da tx). */
  executorAddress: Address;
  chainConfig: ChainConfig;
  profitReceiver: Address;
  slippageBps: number;
  /** Melhor rota (calculator) — define router/dexType/extraData do swap. */
  quote: Quote;
  /** Swap output esperado (loanToken wei) pra derivar minAmountOut. */
  expectedSwapOutput: bigint;
  /** Floor on-chain de lucro (loanToken wei). */
  minProfitWei: bigint;
}

export function buildPreLiquidationTx(
  position: PrePosition,
  plan: PrePlan,
  opts: BuildPreLiquidationOpts,
): BuiltPreLiquidationTx {
  const { executorAddress, chainConfig, profitReceiver, slippageBps, quote, expectedSwapOutput, minProfitWei } = opts;

  const minAmountOut = (expectedSwapOutput * (10_000n - BigInt(slippageBps))) / 10_000n;
  // O calculator só cota UniV3 (single + multi-hop) → router canônico UniV3 (quote.router se fork).
  const router = quote.router ?? chainConfig.uniswapV3.swapRouter02;

  const swapSteps = [
    {
      router,
      tokenIn: position.collateralToken,
      tokenOut: position.loanToken,
      amountIn: 0n, // 0 = usa o saldo (colateral seizado adiantado pelo callback)
      minAmountOut,
      dexType: quote.dex as number,
      extraData: quote.extraData,
    },
  ];

  const params = {
    preLiquidation: position.preLiquidation,
    loanToken: position.loanToken,
    collateralToken: position.collateralToken,
    borrower: position.borrower,
    seizedAssets: 0n, // modo por-shares
    repaidShares: plan.repaidShares,
    swapSteps,
    minProfitWei,
    profitReceiver,
  };

  const data = encodeFunctionData({
    abi: ZEUS_MORPHO_PRELIQUIDATOR_ABI,
    functionName: 'executePreMorphoLiquidation',
    args: [params],
  });

  return {
    to: executorAddress,
    data,
    summary: {
      marketId: position.marketId,
      preLiquidation: position.preLiquidation,
      borrower: position.borrower,
      loanToken: position.loanToken,
      collateralToken: position.collateralToken,
      repaidShares: plan.repaidShares,
      seizedAssets: 0n,
      swapSteps: swapSteps.length,
      minProfitWei,
    },
  };
}
