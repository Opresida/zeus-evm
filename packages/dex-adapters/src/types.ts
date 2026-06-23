/**
 * Tipos compartilhados entre todos os DEX adapters.
 */

import type { Address } from 'viem';

/** Tipo do DEX — deve bater com `enum DexType` no Solidity */
export enum DexType {
  UniswapV2 = 0,
  UniswapV3 = 1,
  Aerodrome = 2,
  Curve = 3,
  Balancer = 4,
  Slipstream = 5,
}

/** Resultado de uma cotação off-chain (sem executar swap) */
export interface Quote {
  /** Origem */
  dex: DexType;
  /** Identificador legível pra logs (ex: "UniV3 0.05%", "Aerodrome stable") */
  source: string;
  /** Endereço do pool ou router que executaria o swap */
  poolOrRouter: Address;
  /**
   * SwapRouter concreto pra EXECUTAR este swap on-chain. Necessário pra forks que reusam um
   * DexType mas têm router próprio (Pancake/Sushi V3 = DexType.UniswapV3; BaseSwap/AlienBase =
   * DexType.UniswapV2). Quando ausente, o txBuilder cai no router canônico do DexType.
   */
  router?: Address;
  /** Token de entrada */
  tokenIn: Address;
  /** Token de saída */
  tokenOut: Address;
  /** Quantidade de entrada (em wei do tokenIn) */
  amountIn: bigint;
  /** Quantidade esperada de saída (em wei do tokenOut) */
  amountOut: bigint;
  /** Preço efetivo (amountOut/amountIn) ajustado por decimais — pra comparação rápida */
  effectivePrice: number;
  /** Gas estimado pra executar este swap (opcional, retornado pelo QuoterV2 quando disponível) */
  gasEstimate?: bigint;
  /** Timestamp da cotação */
  fetchedAt: number;
  /** Bloco da cotação */
  blockNumber: bigint;
  /** Dados extras pra reconstruir SwapStep ao executar (fee tier, isStable, etc.) */
  extraData: `0x${string}`;
}

/** Erro de cotação (preferível a throw pra detector continuar com outras DEX) */
export interface QuoteError {
  source: string;
  reason: string;
  errorCode?: string;
}

export type QuoteResult = Quote | QuoteError;

export function isQuote(result: QuoteResult): result is Quote {
  return 'amountOut' in result;
}
