/**
 * BackrunPlanner — dado um swap whale na mempool, propõe arb cross-DEX
 * pra capturar a dislocation logo após ele executar.
 *
 * Estratégia:
 *   - Whale vendeu tokenIn em DEX_W → preço de tokenOut em DEX_W ficou mais
 *     caro (em termos de tokenIn), preço em DEX_OUTRO ainda não moveu
 *   - Nós COMPRAMOS tokenOut em DEX_OUTRO (preço estagnado, barato)
 *   - VENDEMOS tokenOut em DEX_W (preço já moveu pós-whale, alto)
 *   - Profit = (sellOut − buyIn) menos custos
 *
 * O planner aqui:
 *   1. Resolve TargetPair do par (tokenIn ↔ tokenOut)
 *   2. Decide qual DEX é "oposto" (não-whale)
 *   3. Faz sample logarítmico de amountIn entre $100 e cap
 *   4. Pra cada candidato, quota buy (DEX oposto) → quota sell (DEX whale) → calcula profit
 *
 * NÃO simula on-chain. Isso fica pro profitValidator.
 */

import type { Address, PublicClient } from 'viem';
import {
  quoteUniswapV3,
  quoteAerodrome,
  isQuote,
  DexType,
  type Quote,
  type QuoteResult,
} from '@zeus-evm/dex-adapters';
import type { TargetPair } from '@zeus-evm/chain-config';

import type { WhaleSwap, BackrunOpportunity, WhaleSwapVenue } from './types';

type AnyPublicClient = PublicClient<any, any>;

export interface BackrunPlanParams {
  client: AnyPublicClient;
  whale: WhaleSwap;
  /** TargetPair correspondente (tokenA/tokenB do par). */
  pair: TargetPair;
  /** Endereço do QuoterV2 da chain ativa (UniV3). */
  uniswapV3Quoter: Address;
  /** Endereço do Aerodrome Router (BASE_MAINNET.aerodrome.router). */
  aerodromeRouter: Address;
  /** Endereço da Aerodrome Factory (BASE_MAINNET.aerodrome.factory). */
  aerodromeFactory: Address;
  /** Cap absoluto em wei do tokenA pro amountIn do backrun. */
  maxTradeWei: bigint;
  /** Mínimo absoluto em wei pra evitar dust. */
  minTradeWei: bigint;
  /** Block opcional pra reprodutibilidade. */
  blockNumber?: bigint;
  /** Quantos pontos sampleados (default 8). */
  sampleSize?: number;
}

/**
 * Resolve qual venue alternativa testar pro backrun, dado o whale.
 * Se whale operou em UniV3, testamos compra em Aerodrome (e venda no UniV3).
 * Se whale operou em Aerodrome, testamos compra em UniV3 (e venda em Aerodrome).
 */
function resolveAlternateVenue(whaleVenue: WhaleSwapVenue): 'uniswap-v3' | 'aerodrome' | null {
  if (whaleVenue === 'uniswap-v3') return 'aerodrome';
  if (whaleVenue === 'aerodrome') return 'uniswap-v3';
  return null;
}

/**
 * Quota um swap A→B na venue indicada (escolhe melhor fee tier UniV3 ou pool Aero).
 * Helper interno — caller passa quem é tokenIn/tokenOut.
 */
async function quoteOnVenue(
  client: AnyPublicClient,
  venue: 'uniswap-v3' | 'aerodrome',
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  decimalsIn: number,
  decimalsOut: number,
  pair: TargetPair,
  uniswapV3Quoter: Address,
  aerodromeRouter: Address,
  aerodromeFactory: Address,
  blockNumber?: bigint,
): Promise<Quote | null> {
  if (venue === 'uniswap-v3') {
    let best: Quote | null = null;
    for (const fee of pair.uniswapV3FeeTiers) {
      const result: QuoteResult = await quoteUniswapV3({
        client,
        quoterAddress: uniswapV3Quoter,
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        decimalsIn,
        decimalsOut,
        blockNumber,
      });
      if (isQuote(result)) {
        if (!best || result.amountOut > best.amountOut) best = result;
      }
    }
    return best;
  }

  // Aerodrome — testa volatile e stable, pega melhor
  let best: Quote | null = null;
  if (pair.aerodromeVolatile) {
    const result = await quoteAerodrome({
      client,
      routerAddress: aerodromeRouter,
      factoryAddress: aerodromeFactory,
      tokenIn,
      tokenOut,
      amountIn,
      stable: false,
      decimalsIn,
      decimalsOut,
      blockNumber,
    });
    if (isQuote(result)) best = result;
  }
  if (pair.aerodromeStable) {
    const result = await quoteAerodrome({
      client,
      routerAddress: aerodromeRouter,
      factoryAddress: aerodromeFactory,
      tokenIn,
      tokenOut,
      amountIn,
      stable: true,
      decimalsIn,
      decimalsOut,
      blockNumber,
    });
    if (isQuote(result) && (!best || result.amountOut > best.amountOut)) best = result;
  }
  return best;
}

/**
 * Identifica se o whale move o preço a NOSSO FAVOR ou contra. Backrun só
 * vale quando o whale empurra preço numa direção que cria gap exploitable.
 *
 * Heurística simples: whale vendeu `tokenIn` → preço de `tokenOut` fica mais
 * caro (em tokenIn) na venue dele. Pra fazer backrun:
 *   - COMPRAMOS tokenOut em VENUE_OPOSTA usando tokenIn
 *   - VENDEMOS tokenOut em VENUE_WHALE recebendo tokenIn
 *
 * Logo nosso "tokenA" do TargetPair pra fins de profit é `tokenIn` (o que
 * pagamos e recebemos no fim).
 */
export async function planBackrun(
  params: BackrunPlanParams,
): Promise<BackrunOpportunity | null> {
  const {
    client,
    whale,
    pair,
    uniswapV3Quoter,
    aerodromeRouter,
    aerodromeFactory,
    maxTradeWei,
    minTradeWei,
    blockNumber,
    sampleSize = 8,
  } = params;

  const altVenue = resolveAlternateVenue(whale.venue);
  if (!altVenue) return null;

  // "tokenA" do nosso ciclo arb = whale.tokenIn (start + end ficam em tokenIn).
  const cycleToken = whale.tokenIn;
  const targetToken = whale.tokenOut;

  // Decimais do tokenIn/tokenOut — pegamos do whale (decoder os preenche)
  const cycleDecimals = whale.tokenInDecimals;
  const targetDecimals = whale.tokenOutDecimals;

  if (maxTradeWei < minTradeWei) return null;

  // Sample logarítmico de candidates
  const upperF = Number(maxTradeWei);
  const lowerF = Number(minTradeWei);
  if (!Number.isFinite(upperF) || !Number.isFinite(lowerF) || upperF <= lowerF) {
    // Quando upperF não cabe em number, faz sample linear simples
    return null;
  }

  let best: BackrunOpportunity | null = null;
  const n = Math.max(2, sampleSize);
  for (let i = 0; i < n; i++) {
    const amountIn = BigInt(Math.floor(lowerF * Math.pow(upperF / lowerF, i / (n - 1))));
    if (amountIn <= 0n) continue;

    // Leg 1: BUY targetToken em altVenue (preço estagnado)
    const buyQuote = await quoteOnVenue(
      client,
      altVenue,
      cycleToken,
      targetToken,
      amountIn,
      cycleDecimals,
      targetDecimals,
      pair,
      uniswapV3Quoter,
      aerodromeRouter,
      aerodromeFactory,
      blockNumber,
    );
    if (!buyQuote || buyQuote.amountOut === 0n) continue;

    // Leg 2: SELL targetToken em venue do whale (preço já moveu)
    //
    // ⚠️ Limitação MVP: estamos quotando NO ESTADO ATUAL — não considera o impacto
    // do swap do whale ainda não confirmado. Pra precisão de produção, simular
    // primeiro o whale tx e quotar em fork pós-whale. Por enquanto: edge fica
    // subestimada (conservador, bom pra MVP).
    const sellVenue = whale.venue === 'uniswap-v3' ? 'uniswap-v3' : 'aerodrome';
    const sellQuote = await quoteOnVenue(
      client,
      sellVenue,
      targetToken,
      cycleToken,
      buyQuote.amountOut,
      targetDecimals,
      cycleDecimals,
      pair,
      uniswapV3Quoter,
      aerodromeRouter,
      aerodromeFactory,
      blockNumber,
    );
    if (!sellQuote || sellQuote.amountOut === 0n) continue;

    const finalA = sellQuote.amountOut;
    if (finalA <= amountIn) continue; // sem lucro

    const profitWei = finalA - amountIn;
    const profitBps = Number((profitWei * 10_000n) / amountIn);
    const profitUsd = (Number(profitWei) / Math.pow(10, cycleDecimals)) *
      (cycleToken.toLowerCase() === pair.tokenA.toLowerCase()
        ? pair.estimatedUsdValueA
        : pair.estimatedUsdValueB);

    const opp: BackrunOpportunity = {
      pair,
      whale,
      buyQuote,
      sellQuote,
      amountIn,
      amountOut: finalA,
      profitWei,
      profitBps,
      profitUsd,
      blockNumber: buyQuote.blockNumber,
      detectedAt: Date.now(),
    };

    if (!best || opp.profitWei > best.profitWei) best = opp;
  }

  return best;
}

/**
 * Resolve TargetPair a partir do par do whale (whale.tokenIn ↔ whale.tokenOut).
 * Compara case-insensitive (addresses).
 */
export function findPairForWhale(
  whale: WhaleSwap,
  pairs: readonly TargetPair[],
): TargetPair | null {
  const a = whale.tokenIn.toLowerCase();
  const b = whale.tokenOut.toLowerCase();
  for (const p of pairs) {
    const pa = p.tokenA.toLowerCase();
    const pb = p.tokenB.toLowerCase();
    if ((pa === a && pb === b) || (pa === b && pb === a)) return p;
  }
  return null;
}

/**
 * Re-export DexType pra consumers — facilita logging no app caller.
 */
export { DexType };
