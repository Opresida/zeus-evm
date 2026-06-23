/**
 * Wrapper sobre o Quoter do Aerodrome Slipstream (concentrated liquidity).
 *
 * Igual ao QuoterV2 da Uniswap V3 (reverte com o dado encodado → simulateContract captura),
 * mas a struct usa `int24 tickSpacing` no lugar de `uint24 fee`. extraData = abi.encode(int24).
 *
 * O `router` (Slipstream SwapRouter) é carregado no Quote pro txBuilder executar via
 * `DexType.Slipstream` (SlipstreamLib on-chain).
 */

import type { Address, PublicClient } from 'viem';
import { encodeAbiParameters } from 'viem';

import { DexType, type QuoteResult } from '../types';

type AnyPublicClient = PublicClient<any, any>;

const SLIPSTREAM_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'tokenIn' },
          { type: 'address', name: 'tokenOut' },
          { type: 'uint256', name: 'amountIn' },
          { type: 'int24', name: 'tickSpacing' },
          { type: 'uint160', name: 'sqrtPriceLimitX96' },
        ],
      },
    ],
    outputs: [
      { type: 'uint256', name: 'amountOut' },
      { type: 'uint160', name: 'sqrtPriceX96After' },
      { type: 'uint32', name: 'initializedTicksCrossed' },
      { type: 'uint256', name: 'gasEstimate' },
    ],
  },
] as const;

export interface SlipstreamQuoteParams {
  client: AnyPublicClient;
  /** Slipstream Quoter (cotação off-chain). */
  quoterAddress: Address;
  /** Slipstream SwapRouter — vira o `router` do Quote pra execução. */
  swapRouter: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** tickSpacing do pool CL (1/50/100/200/2000). */
  tickSpacing: number;
  decimalsIn: number;
  decimalsOut: number;
  blockNumber?: bigint;
}

export async function quoteSlipstream(params: SlipstreamQuoteParams): Promise<QuoteResult> {
  const { client, quoterAddress, swapRouter, tokenIn, tokenOut, amountIn, tickSpacing, decimalsIn, decimalsOut, blockNumber } =
    params;

  const source = `Slipstream ts=${tickSpacing}`;

  try {
    const block = blockNumber ?? (await client.getBlockNumber());

    const { result } = await client.simulateContract({
      address: quoterAddress,
      abi: SLIPSTREAM_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          tickSpacing,
          sqrtPriceLimitX96: 0n,
        },
      ],
      blockNumber: block,
    });

    const [amountOut, , , gasEstimate] = result;

    if (amountOut === 0n) {
      return { source, reason: 'amountOut = 0 (pool CL sem liquidez ou inexistente)' };
    }

    const effectivePrice =
      Number(amountOut) / Math.pow(10, decimalsOut) / (Number(amountIn) / Math.pow(10, decimalsIn));

    return {
      dex: DexType.Slipstream,
      source,
      poolOrRouter: swapRouter,
      router: swapRouter,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      effectivePrice,
      gasEstimate,
      fetchedAt: Date.now(),
      blockNumber: block,
      extraData: encodeAbiParameters([{ type: 'int24' }], [tickSpacing]),
    };
  } catch (err) {
    return {
      source,
      reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
    };
  }
}
