/**
 * Uniswap V3 multi-hop quoter (Grupo B do bloqueio mainnet).
 *
 * `quoteExactInputSingle` só cobre 1 pool. Em pairs com pool direto raso,
 * caminhos via intermediate (WETH/USDC) costumam ter MUITO mais liquidez
 * combinada.
 *
 * Path encoding UniV3:
 *   single  : [tokenA, fee, tokenB]
 *   2-hops  : [tokenA, fee1, tokenB, fee2, tokenC]
 *   3-hops  : [tokenA, fee1, tokenB, fee2, tokenC, fee3, tokenD]
 *
 * Encoding bytes:
 *   tokenA(20) | fee1(3) | tokenB(20) | fee2(3) | tokenC(20) ...
 *
 * Multi-chain: UniV3 idêntico em Base/Arb/OP/Polygon/Avalanche/Mainnet.
 */

import type { Address, PublicClient } from 'viem';
import { encodePacked } from 'viem';

import { DexType, type QuoteResult } from '../types';

type AnyPublicClient = PublicClient<any, any>;

const QUOTER_V2_MULTIHOP_ABI = [
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'bytes', name: 'path' },
      { type: 'uint256', name: 'amountIn' },
    ],
    outputs: [
      { type: 'uint256', name: 'amountOut' },
      { type: 'uint160[]', name: 'sqrtPriceX96AfterList' },
      { type: 'uint32[]', name: 'initializedTicksCrossedList' },
      { type: 'uint256', name: 'gasEstimate' },
    ],
  },
] as const;

export interface MultiHopRoute {
  /** Sequência de tokens [tokenIn, intermediate1, ..., tokenOut]. */
  tokens: readonly Address[];
  /** Fee tier de cada pool. tokens.length === fees.length + 1. */
  fees: readonly number[];
}

export interface MultiHopQuoteParams {
  client: AnyPublicClient;
  quoterAddress: Address;
  route: MultiHopRoute;
  amountIn: bigint;
  decimalsIn: number;
  decimalsOut: number;
  blockNumber?: bigint;
}

/**
 * Encoda path UniV3 V3 (packed) — formato consumido pelo QuoterV2.quoteExactInput.
 */
export function encodeUniV3Path(tokens: readonly Address[], fees: readonly number[]): `0x${string}` {
  if (tokens.length < 2) throw new Error('path: pelo menos 2 tokens (tokenIn, tokenOut)');
  if (fees.length !== tokens.length - 1) throw new Error('path: fees.length deve ser tokens.length - 1');

  const types: string[] = [];
  const values: (string | number)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    types.push('address');
    values.push(tokens[i]!);
    if (i < fees.length) {
      types.push('uint24');
      values.push(fees[i]!);
    }
  }
  return encodePacked(types as any, values as any);
}

/**
 * Quote multi-hop via QuoterV2.quoteExactInput.
 */
export async function quoteUniswapV3MultiHop(params: MultiHopQuoteParams): Promise<QuoteResult> {
  const { client, quoterAddress, route, amountIn, decimalsIn, decimalsOut, blockNumber } = params;
  const hops = route.fees.length;
  const source = `UniswapV3 ${hops}-hop [${route.tokens.map((t) => t.slice(0, 6)).join('→')}]`;

  try {
    const path = encodeUniV3Path(route.tokens, route.fees);
    const block = blockNumber ?? (await client.getBlockNumber());

    const { result } = await client.simulateContract({
      address: quoterAddress,
      abi: QUOTER_V2_MULTIHOP_ABI,
      functionName: 'quoteExactInput',
      args: [path, amountIn],
      blockNumber: block,
    });

    const [amountOut, , , gasEstimate] = result;

    if (amountOut === 0n) {
      return { source, reason: 'amountOut = 0 (algum pool no path sem liquidez)' };
    }

    const effectivePrice =
      Number(amountOut) / Math.pow(10, decimalsOut) / (Number(amountIn) / Math.pow(10, decimalsIn));

    return {
      dex: DexType.UniswapV3,
      source,
      poolOrRouter: quoterAddress,
      amountOut,
      tokenIn: route.tokens[0]!,
      tokenOut: route.tokens[route.tokens.length - 1]!,
      amountIn,
      effectivePrice,
      gasEstimate,
      fetchedAt: Date.now(),
      blockNumber: block,
      extraData: path,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return { source, reason: msg.length > 200 ? msg.slice(0, 200) + '…' : msg };
  }
}

/**
 * Gera rotas candidatas via tokens intermediários comuns (WETH, USDC, etc).
 * Caller deve testar TODAS + escolher a com maior amountOut.
 *
 * Fee tiers usados: 100, 500, 3000 (10000 só pra exotics, custo gas alto).
 * Produto cartesiano por hop → cap em N rotas pra não explodir.
 */
export function buildCandidateRoutes(opts: {
  tokenIn: Address;
  tokenOut: Address;
  intermediates: readonly Address[];
  feeTiers?: readonly number[];
  maxRoutes?: number;
}): MultiHopRoute[] {
  const feeTiers = opts.feeTiers ?? [500, 3000, 100];
  const maxRoutes = opts.maxRoutes ?? 12;

  const routes: MultiHopRoute[] = [];

  // Single-hop: tokenIn → tokenOut em cada fee tier
  for (const fee of feeTiers) {
    routes.push({
      tokens: [opts.tokenIn, opts.tokenOut],
      fees: [fee],
    });
  }

  // 2-hops: tokenIn → intermediate → tokenOut
  const tokenInLower = opts.tokenIn.toLowerCase();
  const tokenOutLower = opts.tokenOut.toLowerCase();
  for (const intermediate of opts.intermediates) {
    const intLower = intermediate.toLowerCase();
    if (intLower === tokenInLower || intLower === tokenOutLower) continue;
    for (const fee1 of feeTiers) {
      for (const fee2 of feeTiers) {
        if (routes.length >= maxRoutes) return routes;
        routes.push({
          tokens: [opts.tokenIn, intermediate, opts.tokenOut],
          fees: [fee1, fee2],
        });
      }
    }
  }
  return routes;
}
