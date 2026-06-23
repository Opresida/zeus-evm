/**
 * Quote fanout — busca cotações em TODOS os DEXs disponíveis pra um par em paralelo.
 *
 * Pra Base, sources são:
 *   - Uniswap V3 (multiple fee tiers — 100, 500, 3000, 10000)
 *   - Aerodrome volatile pool (x*y=k)
 *   - Aerodrome stable pool (k=x³y+xy³) — só pra stable-stable e LST-volatile
 *
 * Erros são capturados (QuoteError) em vez de throw — detector continua mesmo
 * se 1 source falhar.
 */

import type { Address, PublicClient } from 'viem';
import { BASE_MAINNET, type TargetPair } from '@zeus-evm/chain-config';
import { quoteUniswapV3, quoteAerodrome, quoteUniswapV2, quoteSlipstream, type QuoteResult } from '@zeus-evm/dex-adapters';

type AnyPublicClient = PublicClient<any, any>;

export interface FanoutParams {
  client: AnyPublicClient;
  pair: TargetPair;
  amountIn: bigint;
  /** Direção: 'AtoB' = vende tokenA, compra tokenB. 'BtoA' = vice-versa */
  direction: 'AtoB' | 'BtoA';
  blockNumber?: bigint;
}

/**
 * Busca quotes pra um par em todos os DEXs/fee tiers configurados na targetPair.
 */
export async function quoteFanout(params: FanoutParams): Promise<QuoteResult[]> {
  const { client, pair, amountIn, direction, blockNumber } = params;

  const [tokenIn, tokenOut, decimalsIn, decimalsOut] =
    direction === 'AtoB'
      ? [pair.tokenA, pair.tokenB, pair.decimalsA, pair.decimalsB]
      : [pair.tokenB, pair.tokenA, pair.decimalsB, pair.decimalsA];

  const tasks: Promise<QuoteResult>[] = [];

  // Uniswap V3: 1 quote por fee tier
  for (const fee of pair.uniswapV3FeeTiers) {
    tasks.push(
      quoteUniswapV3({
        client,
        quoterAddress: BASE_MAINNET.uniswapV3.quoterV2,
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        decimalsIn,
        decimalsOut,
        blockNumber,
      }),
    );
  }

  // Aerodrome volatile (se aplicável)
  if (pair.aerodromeVolatile && BASE_MAINNET.aerodrome) {
    tasks.push(
      quoteAerodrome({
        client,
        routerAddress: BASE_MAINNET.aerodrome.router,
        factoryAddress: BASE_MAINNET.aerodrome.factory,
        tokenIn,
        tokenOut,
        amountIn,
        stable: false,
        decimalsIn,
        decimalsOut,
        blockNumber,
      }),
    );
  }

  // Aerodrome stable (se aplicável)
  if (pair.aerodromeStable && BASE_MAINNET.aerodrome) {
    tasks.push(
      quoteAerodrome({
        client,
        routerAddress: BASE_MAINNET.aerodrome.router,
        factoryAddress: BASE_MAINNET.aerodrome.factory,
        tokenIn,
        tokenOut,
        amountIn,
        stable: true,
        decimalsIn,
        decimalsOut,
        blockNumber,
      }),
    );
  }

  // Forks UniV3 (Pancake/Sushi): 1 quote por fee tier, no quoter/router do fork.
  for (const fork of pair.univ3Forks ?? []) {
    for (const fee of fork.feeTiers) {
      tasks.push(
        quoteUniswapV3({
          client,
          quoterAddress: fork.quoterV2,
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          decimalsIn,
          decimalsOut,
          blockNumber,
        }).then((q) => (q && 'amountOut' in q ? { ...q, router: fork.swapRouter, source: `${fork.venue} ${(fee / 10_000).toFixed(2)}%` } : q)),
      );
    }
  }

  // Slipstream (CL): 1 quote por tickSpacing.
  if (pair.slipstream) {
    const slip = pair.slipstream;
    for (const tickSpacing of slip.tickSpacings) {
      tasks.push(
        quoteSlipstream({
          client,
          quoterAddress: slip.quoter,
          swapRouter: slip.swapRouter,
          tokenIn,
          tokenOut,
          amountIn,
          tickSpacing,
          decimalsIn,
          decimalsOut,
          blockNumber,
        }),
      );
    }
  }

  // DEXes UniV2 (BaseSwap/AlienBase/…): 1 quote por venue, via router.getAmountsOut.
  for (const v2 of pair.univ2Dexes ?? []) {
    tasks.push(
      quoteUniswapV2({
        client,
        routerAddress: v2.router,
        venue: v2.venue,
        tokenIn,
        tokenOut,
        amountIn,
        decimalsIn,
        decimalsOut,
        blockNumber,
      }),
    );
  }

  return Promise.all(tasks);
}
