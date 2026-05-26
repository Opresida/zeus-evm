/**
 * Tipos compartilhados do motor de backrun de dislocation.
 *
 * Fluxo:
 *   1. Detector vê swap whale na mempool → emite WhaleSwap
 *   2. Backrun-engine recebe WhaleSwap → backrunPlanner constrói BackrunOpportunity
 *   3. profitValidator simula on-chain → se passa, dispatcher submete via flashloan
 *
 * Flashloan-friendly: a oportunidade é cross-DEX arb cuja janela abre QUANDO o whale
 * move o preço em uma das venues. Atômica (loan + arb + repay na mesma tx).
 */

import type { Address } from 'viem';
import type { TargetPair } from '@zeus-evm/chain-config';
import type { Quote } from '@zeus-evm/dex-adapters';

/** DEX onde o swap whale foi observado. */
export type WhaleSwapVenue = 'uniswap-v3' | 'aerodrome' | 'unknown';

/**
 * Swap whale detectado na mempool. Estrutura mínima pra o backrun decidir
 * (decoder extrai isso da calldata da pending tx).
 */
export interface WhaleSwap {
  /** Hash da pending tx do whale. */
  pendingTxHash: `0x${string}`;
  /** DEX/venue do swap. */
  venue: WhaleSwapVenue;
  /** Router/pool address envolvido. */
  router: Address;
  /** Token de entrada (vendido pelo whale). */
  tokenIn: Address;
  /** Token de saída (comprado pelo whale). */
  tokenOut: Address;
  /** Quantidade de entrada (wei do tokenIn). */
  amountIn: bigint;
  /** Estimativa em USD do tamanho do swap. */
  amountInUsd: number;
  /** Sender — quando disponível na pending tx. */
  sender: Address | null;
  /** Decimais do tokenIn (pra log/formatação). */
  tokenInDecimals: number;
  /** Decimais do tokenOut. */
  tokenOutDecimals: number;
  /** Symbol opcional pra log. */
  tokenInSymbol?: string;
  tokenOutSymbol?: string;
  /** Block atual quando o swap foi observado. */
  observedAtBlock: bigint;
  detectedAt: number;
}

/**
 * Resultado do backrunPlanner — oportunidade arb pós-whale, pronta pra simular.
 *
 * Estrutura espelha CrossDexOpportunity mas o `buyQuote` é específico:
 * vamos COMPRAR na venue OPOSTA à do whale (preço ainda estagnado) e VENDER
 * na venue do whale (preço já moveu na nossa direção pós-swap).
 */
export interface BackrunOpportunity {
  /** Par de tokens identificado (usa TargetPair se disponível). */
  pair: TargetPair;
  /** Whale swap original que gerou a oportunidade. */
  whale: WhaleSwap;
  /** Quote do leg de compra (no DEX oposto ao whale). */
  buyQuote: Quote;
  /** Quote do leg de venda (no MESMO DEX do whale, após ele mover preço). */
  sellQuote: Quote;
  /** Amount inicial em wei do tokenA (a financiar via flashloan). */
  amountIn: bigint;
  /** Amount final esperado em wei do tokenA. */
  amountOut: bigint;
  /** Profit absoluto em wei do tokenA. */
  profitWei: bigint;
  /** Profit em bps do amountIn. */
  profitBps: number;
  /** Estimativa em USD. */
  profitUsd: number;
  /** Bloco da cotação. */
  blockNumber: bigint;
  detectedAt: number;
}

/**
 * Parâmetros do priceImpactCalculator — estima o novo preço em uma pool UniV3-like
 * após um swap de `swapAmountIn` ser executado.
 */
export interface PriceImpactInput {
  /** Reserva de tokenIn na pool antes do swap (wei). */
  reserveIn: bigint;
  /** Reserva de tokenOut na pool antes do swap (wei). */
  reserveOut: bigint;
  /** Quantidade de tokenIn vendida pelo whale (wei). */
  swapAmountIn: bigint;
  /** Fee do pool em bps (UniV3: 100/500/3000/10000 → /10000). */
  feeBps: number;
}

export interface PriceImpactResult {
  /** Amount de tokenOut que o whale RECEBE (após fee + slippage do pool). */
  amountOut: bigint;
  /** Reserva projetada de tokenIn DEPOIS do swap. */
  reserveInAfter: bigint;
  /** Reserva projetada de tokenOut DEPOIS do swap. */
  reserveOutAfter: bigint;
  /** Movimento de preço em bps (positivo = tokenOut ficou mais caro pra quem compra). */
  priceImpactBps: number;
}
