/**
 * Pares de tokens que o detector vai observar inicialmente.
 *
 * Estratégia conservadora (Fase 2 DRY_RUN):
 * Mistura de blue chip (WETH/USDC pra calibrar matemática) + medium-cap
 * com liquidez confiável. Sem long-tail/memes nesse stage — ruído alto.
 *
 * Após validar matemática e thresholds com esses 5, podemos expandir.
 */

import type { Address } from 'viem';
import { BASE_MAINNET } from './base';

export interface TargetPair {
  /** Identificador legível tipo "WETH/USDC" */
  id: string;
  /** Token A (não-ordenado, lib normaliza pra hash menor primeiro) */
  tokenA: Address;
  /** Token B */
  tokenB: Address;
  /** Decimais do tokenA (cache pra evitar RPC) */
  decimalsA: number;
  /** Decimais do tokenB */
  decimalsB: number;
  /** Categoria pra logs/filtros */
  category: 'stable-stable' | 'lst-volatile' | 'volatile-stable' | 'volatile-volatile';
  /** Estimativa de USD value de 1 unidade do tokenA (cache; preço real vem on-chain) */
  estimatedUsdValueA: number;
  /** Idem tokenB */
  estimatedUsdValueB: number;
  /** Quais fee tiers do Uniswap V3 valem observar (a maioria não tem todos os 4) */
  uniswapV3FeeTiers: readonly number[];
  /** Aerodrome tem pool stable? Volatile? */
  aerodromeStable: boolean;
  aerodromeVolatile: boolean;
}

const T = BASE_MAINNET.tokens;

export const BASE_TARGET_PAIRS: TargetPair[] = [
  {
    id: 'WETH/USDC',
    tokenA: T.WETH,
    tokenB: T.USDC,
    decimalsA: 18,
    decimalsB: 6,
    category: 'volatile-stable',
    estimatedUsdValueA: 2100, // ~ETH price
    estimatedUsdValueB: 1,
    uniswapV3FeeTiers: [500, 3000], // 0.05% (alta liquidez) + 0.3%
    aerodromeStable: false,
    aerodromeVolatile: true,
  },
  {
    id: 'cbETH/WETH',
    tokenA: T.cbETH,
    tokenB: T.WETH,
    decimalsA: 18,
    decimalsB: 18,
    category: 'lst-volatile',
    estimatedUsdValueA: 2100, // cbETH ~= ETH
    estimatedUsdValueB: 2100,
    uniswapV3FeeTiers: [500, 100], // LST = baixa volatilidade, fee 0.05% ou 0.01%
    aerodromeStable: true,  // cbETH/WETH é pool stable em Aerodrome
    aerodromeVolatile: false,
  },
  {
    id: 'USDC/USDT',
    tokenA: T.USDC,
    tokenB: T.USDT,
    decimalsA: 6,
    decimalsB: 6,
    category: 'stable-stable',
    estimatedUsdValueA: 1,
    estimatedUsdValueB: 1,
    uniswapV3FeeTiers: [100], // 0.01% — padrão pra stable-stable
    aerodromeStable: true,
    aerodromeVolatile: false,
  },
  {
    id: 'WETH/AERO',
    tokenA: T.WETH,
    tokenB: T.AERO,
    decimalsA: 18,
    decimalsB: 18,
    category: 'volatile-volatile',
    estimatedUsdValueA: 2100,
    estimatedUsdValueB: 0.5, // AERO ~$0.5
    uniswapV3FeeTiers: [3000], // 0.3% pra volatile-volatile
    aerodromeStable: false,
    aerodromeVolatile: true,
  },
  {
    id: 'USDC/DAI',
    tokenA: T.USDC,
    tokenB: T.DAI,
    decimalsA: 6,
    decimalsB: 18,
    category: 'stable-stable',
    estimatedUsdValueA: 1,
    estimatedUsdValueB: 1,
    uniswapV3FeeTiers: [100], // 0.01%
    aerodromeStable: true,
    aerodromeVolatile: false,
  },
];

/** Lookup helper */
export function findPairById(id: string): TargetPair | undefined {
  return BASE_TARGET_PAIRS.find((p) => p.id === id);
}
