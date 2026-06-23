/**
 * Wrapper sobre routers UniswapV2-compatíveis (BaseSwap, AlienBase, SwapBased…).
 *
 * UniV2 não tem QuoterV2 — a cotação exata vem do próprio router via `getAmountsOut`
 * (view, x*y=k com fee fixa do par). Path direto [tokenIn, tokenOut] = 1 hop.
 *
 * O `router` é carregado no Quote (campo `router`) pra o txBuilder executar no venue certo —
 * vários venues compartilham `DexType.UniswapV2`, então o router desambigua.
 */

import type { Address, PublicClient } from 'viem';

import { DexType, type QuoteResult } from '../types';

type AnyPublicClient = PublicClient<any, any>;

const UNIV2_ROUTER_ABI = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { type: 'uint256', name: 'amountIn' },
      { type: 'address[]', name: 'path' },
    ],
    outputs: [{ type: 'uint256[]', name: 'amounts' }],
  },
] as const;

export interface UniswapV2QuoteParams {
  client: AnyPublicClient;
  /** Router02 do venue (BaseSwap/AlienBase/…). Vira o `router` do Quote pra execução. */
  routerAddress: Address;
  /** Nome do venue pra logs (ex: 'baseswap'). */
  venue?: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  decimalsIn: number;
  decimalsOut: number;
  blockNumber?: bigint;
}

export async function quoteUniswapV2(params: UniswapV2QuoteParams): Promise<QuoteResult> {
  const { client, routerAddress, venue, tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, blockNumber } = params;

  const source = `UniswapV2 ${venue ?? routerAddress.slice(0, 8)}`;

  try {
    const block = blockNumber ?? (await client.getBlockNumber());

    const amounts = await client.readContract({
      address: routerAddress,
      abi: UNIV2_ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [amountIn, [tokenIn, tokenOut]],
      blockNumber: block,
    });

    const amountOut = amounts[amounts.length - 1] ?? 0n;

    if (amountOut === 0n) {
      return { source, reason: 'amountOut = 0 (par sem liquidez ou inexistente)' };
    }

    const effectivePrice =
      Number(amountOut) / Math.pow(10, decimalsOut) / (Number(amountIn) / Math.pow(10, decimalsIn));

    return {
      dex: DexType.UniswapV2,
      source,
      poolOrRouter: routerAddress,
      router: routerAddress,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      effectivePrice,
      fetchedAt: Date.now(),
      blockNumber: block,
      extraData: '0x', // UniV2 não tem fee tier nem tickSpacing
    };
  } catch (err) {
    return {
      source,
      reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
    };
  }
}
