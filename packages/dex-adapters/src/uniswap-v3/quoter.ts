/**
 * Wrapper sobre Uniswap V3 QuoterV2.
 *
 * QuoterV2 é o método canônico pra obter cotações exatas off-chain.
 * Roda como `eth_call` (não custa gas), retornando o exato `amountOut` que
 * um swap real receberia. Inclui também gas estimate e sqrtPriceX96 final.
 *
 * IMPORTANTE: QuoterV2 NÃO é uma função `view`. Ele reverte intencionalmente
 * com os dados encodados — o `eth_call` captura o revert e retorna o dado.
 * Por isso, em viem usa `simulateContract` ou `readContract` (que abstraem).
 */

import type { Address, PublicClient } from 'viem';
import { encodeAbiParameters } from 'viem';

import { DexType, type QuoteResult } from '../types';

/** PublicClient sem restrição de generics — evita conflito de tipo viem entre workspaces */
type AnyPublicClient = PublicClient<any, any>;

/// ABI mínima do QuoterV2 — só a função que usamos.
const QUOTER_V2_ABI = [
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
          { type: 'uint24', name: 'fee' },
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

export interface UniswapV3QuoteParams {
  client: AnyPublicClient;
  quoterAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee: number; // 100, 500, 3000, 10000
  decimalsIn: number;
  decimalsOut: number;
  blockNumber?: bigint;
}

/**
 * Cotação Uniswap V3 via QuoterV2 (preciso, simula swap real on-chain).
 * Retorna QuoteError em vez de throw se a pool não existe ou liquidez insuficiente.
 */
export async function quoteUniswapV3(params: UniswapV3QuoteParams): Promise<QuoteResult> {
  const { client, quoterAddress, tokenIn, tokenOut, amountIn, fee, decimalsIn, decimalsOut, blockNumber } = params;

  const source = `UniswapV3 ${(fee / 10_000).toFixed(2)}%`;

  try {
    const block = blockNumber ?? (await client.getBlockNumber());

    const { result } = await client.simulateContract({
      address: quoterAddress,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
      blockNumber: block,
    });

    const [amountOut, , , gasEstimate] = result;

    if (amountOut === 0n) {
      return {
        source,
        reason: 'amountOut = 0 (pool sem liquidez ou par inexistente)',
      };
    }

    const effectivePrice =
      Number(amountOut) / Math.pow(10, decimalsOut) / (Number(amountIn) / Math.pow(10, decimalsIn));

    return {
      dex: DexType.UniswapV3,
      source,
      poolOrRouter: quoterAddress, // pool real é resolvido pelo router no swap
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      effectivePrice,
      gasEstimate,
      fetchedAt: Date.now(),
      blockNumber: block,
      extraData: encodeAbiParameters([{ type: 'uint24' }], [fee]),
    };
  } catch (err) {
    // QuoterV2 reverte (pool não existe, liquidez insuficiente, etc.)
    return {
      source,
      reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
    };
  }
}
