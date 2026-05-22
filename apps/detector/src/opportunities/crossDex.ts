/**
 * Cross-DEX Arbitrage Detector
 *
 * Pra um par de tokens A/B e um amountIn em A:
 *   1. Busca quotes A→B em todos os DEXs (forward)
 *   2. Pra cada quote forward (= "comprar B"), busca quotes B→A (reverse)
 *      usando amountOut do forward como input
 *   3. Pra cada combo (buyDex, sellDex), calcula: finalA = sellQuote.amountOut
 *   4. Se finalA > amountIn → arbitrage opportunity
 *
 * Estratégia: busca a melhor combinação (maior profit líquido) em N² possibilidades.
 * Pra Base com 2-3 DEXs simultâneos, N=3 e RPC fanout total ~6 chamadas (rápido).
 */

import type { Address, PublicClient } from 'viem';
import type { TargetPair } from '@zeus-evm/chain-config';
import { isQuote, type Quote, type QuoteResult } from '@zeus-evm/dex-adapters';

import { quoteFanout } from './quoteFanout';

type AnyPublicClient = PublicClient<any, any>;

export interface CrossDexOpportunity {
  pair: TargetPair;
  direction: 'AtoB-BtoA' | 'BtoA-AtoB';
  /** Quote do "buy leg" (1ª swap) */
  buyQuote: Quote;
  /** Quote do "sell leg" (2ª swap, com input = amountOut do buy) */
  sellQuote: Quote;
  /** Quantidade inicial (tokenA) */
  amountIn: bigint;
  /** Quantidade final esperada (tokenA) */
  amountOut: bigint;
  /** Profit absoluto em wei do tokenA */
  profitWei: bigint;
  /** Profit em % do amountIn */
  profitBps: number;
  /** Estimativa de profit em USD (usa estimatedUsdValueA do pair) */
  profitUsd: number;
  /** Block onde a oportunidade foi detectada */
  blockNumber: bigint;
  detectedAt: number;
}

export interface FindArbParams {
  client: AnyPublicClient;
  pair: TargetPair;
  /** Quantidade a testar em tokenA (em wei) */
  amountInA: bigint;
  /** Block opcional (pra reprodutibilidade) */
  blockNumber?: bigint;
}

/**
 * Busca a melhor oportunidade cross-DEX pra um par.
 * Retorna null se nenhum combo for lucrativo.
 */
export async function findCrossDexArb(params: FindArbParams): Promise<CrossDexOpportunity | null> {
  const { client, pair, amountInA, blockNumber } = params;

  // ─── 1) Forward quotes: tokenA → tokenB ───
  const forwardQuotes = (await quoteFanout({
    client,
    pair,
    amountIn: amountInA,
    direction: 'AtoB',
    blockNumber,
  })).filter(isQuote);

  if (forwardQuotes.length < 2) {
    // Precisa de pelo menos 2 DEXs com liquidez pra fazer cross-DEX arb
    return null;
  }

  let bestOpp: CrossDexOpportunity | null = null;

  // ─── 2) Pra cada forward, testa sell em todos os outros DEXs ───
  for (const buyQuote of forwardQuotes) {
    const reverseQuotes = (await quoteFanout({
      client,
      pair,
      amountIn: buyQuote.amountOut,
      direction: 'BtoA',
      blockNumber,
    })).filter(isQuote);

    for (const sellQuote of reverseQuotes) {
      // Pular mesma source (não é arb)
      if (sellQuote.source === buyQuote.source) continue;

      const finalA = sellQuote.amountOut;
      if (finalA <= amountInA) continue; // sem lucro

      const profitWei = finalA - amountInA;
      const profitBps = Number((profitWei * 10_000n) / amountInA);
      const profitUsd = (Number(profitWei) / Math.pow(10, pair.decimalsA)) * pair.estimatedUsdValueA;

      const opp: CrossDexOpportunity = {
        pair,
        direction: 'AtoB-BtoA',
        buyQuote,
        sellQuote,
        amountIn: amountInA,
        amountOut: finalA,
        profitWei,
        profitBps,
        profitUsd,
        blockNumber: buyQuote.blockNumber,
        detectedAt: Date.now(),
      };

      if (!bestOpp || opp.profitWei > bestOpp.profitWei) {
        bestOpp = opp;
      }
    }
  }

  return bestOpp;
}
