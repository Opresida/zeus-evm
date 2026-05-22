/**
 * TxBuilder — converte CrossDexOpportunity → calldata pronto pra `eth_call` / `sendTransaction`.
 *
 * Mapeia os Quotes (que sabem qual DEX e fee) pra `SwapStep[]` que o ZeusExecutor
 * entende. Encoda via ABI do ZeusExecutor.
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';

import { ZEUS_EXECUTOR_ABI } from './abi';
import { DexType, type Quote } from '@zeus-evm/dex-adapters';
import { BASE_MAINNET } from '@zeus-evm/chain-config';
import type { CrossDexOpportunity } from '../opportunities';

/** SwapStep como o contrato espera */
export interface SolidityNumSwapStep {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  dexType: number; // uint8
  extraData: Hex;
}

/**
 * Resolve o `router` correto pra cada Quote.
 * QuoterV2 não é executor — precisamos do SwapRouter02 (UniV3) ou Aerodrome Router.
 */
function resolveRouter(dex: DexType): Address {
  switch (dex) {
    case DexType.UniswapV3:
      return BASE_MAINNET.uniswapV3.swapRouter02;
    case DexType.Aerodrome:
      if (!BASE_MAINNET.aerodrome) throw new Error('Aerodrome config missing');
      return BASE_MAINNET.aerodrome.router;
    default:
      throw new Error(`Unsupported DexType: ${dex}`);
  }
}

/**
 * Constrói os 2 SwapSteps a partir de uma CrossDexOpportunity.
 * Step 1: buy (tokenA→tokenB)
 * Step 2: sell (tokenB→tokenA com amountIn=0 = usa saldo atual)
 */
export function buildSwapSteps(opp: CrossDexOpportunity, slippageBps: number = 50): SolidityNumSwapStep[] {
  const slippageDivisor = 10_000n - BigInt(slippageBps);

  // Aplica slippage: aceita até (1 - slippageBps/10000) do amountOut esperado
  const buyMin = (opp.buyQuote.amountOut * slippageDivisor) / 10_000n;
  const sellMin = (opp.sellQuote.amountOut * slippageDivisor) / 10_000n;

  return [
    {
      router: resolveRouter(opp.buyQuote.dex),
      tokenIn: opp.buyQuote.tokenIn,
      tokenOut: opp.buyQuote.tokenOut,
      amountIn: opp.amountIn,
      minAmountOut: buyMin,
      dexType: opp.buyQuote.dex,
      extraData: opp.buyQuote.extraData,
    },
    {
      router: resolveRouter(opp.sellQuote.dex),
      tokenIn: opp.sellQuote.tokenIn,
      tokenOut: opp.sellQuote.tokenOut,
      amountIn: 0n, // usa saldo atual de tokenB do step anterior
      minAmountOut: sellMin,
      dexType: opp.sellQuote.dex,
      extraData: opp.sellQuote.extraData,
    },
  ];
}

export interface BuildArbCalldataParams {
  opp: CrossDexOpportunity;
  profitReceiver: Address;
  slippageBps?: number;
  /** Margem de segurança: minProfit aceito é (oppProfit * marginBps) / 10_000 */
  minProfitMarginBps?: number;
}

/**
 * Encoda calldata pra executeArbitrage (modalidade capital próprio).
 */
export function buildArbitrageCalldata(params: BuildArbCalldataParams): Hex {
  const { opp, profitReceiver, slippageBps = 50, minProfitMarginBps = 7_500 } = params;

  const steps = buildSwapSteps(opp, slippageBps);
  const minProfit = (opp.profitWei * BigInt(minProfitMarginBps)) / 10_000n;

  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeArbitrage',
    args: [
      {
        steps,
        minProfitWei: minProfit,
        profitToken: opp.pair.tokenA,
        profitReceiver,
      },
    ],
  });
}

export interface BuildFlashloanCalldataParams extends BuildArbCalldataParams {
  /** Asset emprestado (geralmente o profitToken pra simplicidade) */
  flashloanAsset: Address;
  /** Quantia emprestada */
  flashloanAmount: bigint;
}

/**
 * Encoda calldata pra executeFlashloanArbitrage (modalidade flashloan).
 */
export function buildFlashloanCalldata(params: BuildFlashloanCalldataParams): Hex {
  const { opp, profitReceiver, slippageBps = 50, minProfitMarginBps = 7_500, flashloanAsset, flashloanAmount } = params;

  const steps = buildSwapSteps(opp, slippageBps);
  const minProfit = (opp.profitWei * BigInt(minProfitMarginBps)) / 10_000n;

  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeFlashloanArbitrage',
    args: [
      flashloanAsset,
      flashloanAmount,
      {
        steps,
        minProfitWei: minProfit,
        profitToken: opp.pair.tokenA,
        profitReceiver,
      },
    ],
  });
}
