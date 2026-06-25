/**
 * bestSwapAcrossDexes — melhor swap single-hop entre as DEX que o ZeusLiquidator EXECUTA.
 *
 * Análogo do `quoteFanout` do Motor 2, mas pra um único best-swap (1 direção): dado
 * (tokenIn, tokenOut, amountIn), cota UniV3 (fee tiers) + Aerodrome (stable/volatile) +
 * Slipstream (tickSpacings) reusando os quoters existentes e devolve o melhor `Quote`
 * (maior `amountOut`), com o `router` já normalizado pro SwapRouter de EXECUÇÃO (não o quoter).
 *
 * Usado pelo liquidator (Motor 1) pra trocar o colateral seizado pela dívida no melhor preço,
 * em vez de chumbar o Uniswap V3. O `Quote` retornado carrega dex/router/extraData prontos
 * pro builder montar o `SwapStep` (mesmo padrão do `buildSwapSteps`).
 *
 * IMPORTANTE: só single-hop (o que o contrato executa via *Lib.swap). Multi-hop fica de fora.
 */

import type { Address, PublicClient } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';

import { quoteUniswapV3 } from './uniswap-v3/quoter';
import { quoteAerodrome } from './aerodrome/router';
import { quoteSlipstream } from './slipstream/quoter';
import { isQuote, type Quote, type QuoteResult } from './types';

type AnyPublicClient = PublicClient<any, any>;

export interface BestSwapOpts {
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  decimalsIn: number;
  decimalsOut: number;
  blockNumber?: bigint;
  /** Limita os venues (default: todos os que o ZeusLiquidator executa = UniV3 + Aero + Slipstream). */
  includeAerodrome?: boolean;
  includeSlipstream?: boolean;
}

/** Anexa o router de EXECUÇÃO ao Quote (UniV3/Aero não setam `router`; Slipstream já seta). */
function withRouter(router: Address): (q: QuoteResult) => QuoteResult {
  return (q) => (isQuote(q) ? { ...q, router } : q);
}

/**
 * Cota todas as DEX suportadas e devolve o melhor `Quote` (maior amountOut), ou null se nenhuma cotou.
 * Erros de venue individual viram `QuoteError` (filtrados) — uma DEX sem pool não derruba o resto.
 */
export async function bestSwapAcrossDexes(opts: BestSwapOpts): Promise<Quote | null> {
  const { client, chainConfig, tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut, blockNumber } = opts;
  const includeAerodrome = opts.includeAerodrome ?? true;
  const includeSlipstream = opts.includeSlipstream ?? true;

  const tasks: Promise<QuoteResult>[] = [];

  // Uniswap V3 — 1 cotação por fee tier.
  const uni = chainConfig.uniswapV3;
  if (uni?.quoterV2 && uni.swapRouter02) {
    for (const fee of uni.feeTiers) {
      tasks.push(
        quoteUniswapV3({ client, quoterAddress: uni.quoterV2, tokenIn, tokenOut, amountIn, fee, decimalsIn, decimalsOut, blockNumber })
          .then(withRouter(uni.swapRouter02)),
      );
    }
  }

  // Aerodrome — stable e volatile.
  if (includeAerodrome && chainConfig.aerodrome) {
    const aero = chainConfig.aerodrome;
    for (const stable of [false, true]) {
      tasks.push(
        quoteAerodrome({ client, routerAddress: aero.router, factoryAddress: aero.factory, tokenIn, tokenOut, amountIn, stable, decimalsIn, decimalsOut, blockNumber })
          .then(withRouter(aero.router)),
      );
    }
  }

  // Slipstream (CL) — 1 cotação por tickSpacing (já carrega o swapRouter no Quote).
  if (includeSlipstream && chainConfig.slipstream) {
    const slip = chainConfig.slipstream;
    for (const tickSpacing of slip.tickSpacings) {
      tasks.push(
        quoteSlipstream({ client, quoterAddress: slip.quoter, swapRouter: slip.swapRouter, tokenIn, tokenOut, amountIn, tickSpacing, decimalsIn, decimalsOut, blockNumber }),
      );
    }
  }

  const results = await Promise.all(tasks);
  let best: Quote | null = null;
  for (const r of results) {
    if (isQuote(r) && (best === null || r.amountOut > best.amountOut)) best = r;
  }
  return best;
}
