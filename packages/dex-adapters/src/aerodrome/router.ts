/**
 * Wrapper sobre Aerodrome Router (Velodrome fork).
 *
 * Aerodrome tem 2 tipos de pool:
 *   - **Volatile** (x*y=k, igual UniV2) — pra pares como WETH/AERO
 *   - **Stable** (k = x³y + xy³) — pra stable-stable (USDC/USDT) e LST-volatile (cbETH/WETH)
 *
 * O `Router.getAmountsOut(amountIn, routes[])` retorna a quantidade exata pra cada
 * hop de uma rota. Pra single-hop, usamos `routes = [Route(from, to, stable, factory)]`.
 */

import type { Address, PublicClient } from 'viem';
import { encodeAbiParameters, zeroAddress } from 'viem';

import { DexType, type QuoteResult } from '../types';

/** PublicClient sem restrição de generics — evita conflito de tipo viem entre workspaces */
type AnyPublicClient = PublicClient<any, any>;

const AERODROME_ROUTER_ABI = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { type: 'uint256', name: 'amountIn' },
      {
        type: 'tuple[]',
        name: 'routes',
        components: [
          { type: 'address', name: 'from' },
          { type: 'address', name: 'to' },
          { type: 'bool', name: 'stable' },
          { type: 'address', name: 'factory' },
        ],
      },
    ],
    outputs: [{ type: 'uint256[]', name: 'amounts' }],
  },
] as const;

export interface AerodromeQuoteParams {
  client: AnyPublicClient;
  routerAddress: Address;
  factoryAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  /** true = pool stable (k=x³y+xy³), false = pool volatile (k=xy) */
  stable: boolean;
  decimalsIn: number;
  decimalsOut: number;
  blockNumber?: bigint;
}

export async function quoteAerodrome(params: AerodromeQuoteParams): Promise<QuoteResult> {
  const {
    client,
    routerAddress,
    factoryAddress,
    tokenIn,
    tokenOut,
    amountIn,
    stable,
    decimalsIn,
    decimalsOut,
    blockNumber,
  } = params;

  const source = `Aerodrome ${stable ? 'stable' : 'volatile'}`;

  try {
    const block = blockNumber ?? (await client.getBlockNumber());

    const amounts = await client.readContract({
      address: routerAddress,
      abi: AERODROME_ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [
        amountIn,
        [
          {
            from: tokenIn,
            to: tokenOut,
            stable,
            factory: factoryAddress,
          },
        ],
      ],
      blockNumber: block,
    });

    const amountOut = amounts[amounts.length - 1] ?? 0n;

    if (amountOut === 0n) {
      return {
        source,
        reason: `amountOut = 0 (pool ${stable ? 'stable' : 'volatile'} sem liquidez ou inexistente)`,
      };
    }

    const effectivePrice =
      Number(amountOut) / Math.pow(10, decimalsOut) / (Number(amountIn) / Math.pow(10, decimalsIn));

    return {
      dex: DexType.Aerodrome,
      source,
      poolOrRouter: routerAddress,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      effectivePrice,
      fetchedAt: Date.now(),
      blockNumber: block,
      extraData: encodeAbiParameters(
        [{ type: 'bool' }, { type: 'address' }],
        [stable, factoryAddress === zeroAddress ? factoryAddress : factoryAddress],
      ),
    };
  } catch (err) {
    return {
      source,
      reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
    };
  }
}
