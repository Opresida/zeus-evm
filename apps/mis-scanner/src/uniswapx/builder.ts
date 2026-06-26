/**
 * Motor 2 / Filler UniswapX — builder de calldata pro executeFill.
 *
 * Monta UniswapXFillParams: reactor + a ordem assinada + swapStep (input→saída, amountIn=0=usa o input
 * que o reactor entrega) + profitToken + minProfitWei + profitReceiver. minAmountOut do swap = saída
 * requerida (garante cobrir a ordem; o surplus acima disso é o lucro).
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';
import type { Quote } from '@zeus-evm/dex-adapters';

import { ZEUS_UNISWAPX_FILLER_ABI } from './abi';
import type { NormalizedOrder, FillEvaluation } from './types';

export interface BuiltFillTx {
  to: Address;
  data: Hex;
  summary: {
    reactor: Address;
    orderHash: Hex;
    profitToken: Address;
    requiredOut: string;
    minProfitWei: string;
  };
}

export interface BuildFillOpts {
  /** Nosso ZeusUniswapXFiller (alvo da tx). */
  fillerAddress: Address;
  profitReceiver: Address;
  /** Rota do sourcing (do quoter) — define router/dexType/extraData do swap. */
  quote: Quote;
  /** Resultado da avaliação (requiredOut + minProfitWei). */
  evaluation: FillEvaluation;
}

export function buildFillTx(order: NormalizedOrder, opts: BuildFillOpts): BuiltFillTx {
  const { fillerAddress, profitReceiver, quote, evaluation } = opts;
  if (!evaluation.ok || evaluation.requiredOut === undefined || evaluation.profitToken === undefined) {
    throw new Error('buildFillTx: avaliação inválida');
  }

  const swapSteps = [
    {
      router: quote.router ?? quote.poolOrRouter,
      tokenIn: order.input.token,
      tokenOut: evaluation.profitToken,
      amountIn: 0n, // usa o saldo (input que o reactor entrega no callback)
      minAmountOut: evaluation.requiredOut, // mínimo = cobre a saída da ordem; surplus = lucro
      dexType: quote.dex as number,
      extraData: quote.extraData,
    },
  ];

  const params = {
    reactor: order.reactor,
    order: { order: order.signedOrder, sig: order.signature },
    swapSteps,
    profitToken: evaluation.profitToken,
    minProfitWei: evaluation.minProfitWei ?? 0n,
    profitReceiver,
  };

  const data = encodeFunctionData({
    abi: ZEUS_UNISWAPX_FILLER_ABI,
    functionName: 'executeFill',
    args: [params],
  });

  return {
    to: fillerAddress,
    data,
    summary: {
      reactor: order.reactor,
      orderHash: order.orderHash,
      profitToken: evaluation.profitToken,
      requiredOut: evaluation.requiredOut.toString(),
      minProfitWei: (evaluation.minProfitWei ?? 0n).toString(),
    },
  };
}
