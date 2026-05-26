/**
 * Pares de tokens que o detector vai observar — Trilha 2 (Radar Longtail/Medium-cap).
 *
 * Versão 2 (2026-05-23): Após backtest provar que blue chips (WETH/USDC etc) não têm
 * edge cross-DEX em Base 2026, pivotamos pra pares onde Aerodrome e UniswapV3 têm
 * liquidez SIGNIFICATIVA mas DESBALANCEADA — geralmente Aero domina e UniV3 fica menor.
 * Essa fragmentação é o que cria janelas de arb não capturadas por MEV bots.
 *
 * Tokens descartados desta lista vivem em `docs/NO_EDGE_TOKENS.md` (manter atualizado).
 *
 * Critérios de inclusão (validados via `apps/backtest/src/discover-pairs.ts`):
 *   1. Pool UniV3 com TVL ≥ $50k em pelo menos 1 fee tier
 *   2. Pool Aerodrome (stable ou volatile) com TVL ≥ $50k
 *   3. Token volátil ou com fragmentação de liquidez (não-pegged)
 */

import type { Address } from 'viem';
import { BASE_MAINNET } from './base';

export interface TargetPair {
  /** Identificador legível tipo "AERO/USDC" */
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
  // ─────────────────────────────────────────────────────────────────────
  //  AERO/USDC — par estrela da Trilha 2
  //  UniV3 fee500=$75k vs Aerodrome volatile=$26,3M (350x maior)
  //  Edge esperada: alta — Aerodrome domina, UniV3 demora a refletir movimentos
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'AERO/USDC',
    tokenA: T.AERO,
    tokenB: T.USDC,
    decimalsA: 18,
    decimalsB: 6,
    category: 'volatile-stable',
    estimatedUsdValueA: 0.42, // AERO ~$0.42 (snapshot 2026-05-23)
    estimatedUsdValueB: 1,
    uniswapV3FeeTiers: [500], // fee500 é o único com TVL viável
    aerodromeStable: false,
    aerodromeVolatile: true,
  },
  // ─────────────────────────────────────────────────────────────────────
  //  AERO/WETH — mesmo motivo, par WETH
  //  UniV3 fee3000=$536k + fee10000=$59k vs Aerodrome volatile=$2,8M
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'AERO/WETH',
    tokenA: T.AERO,
    tokenB: T.WETH,
    decimalsA: 18,
    decimalsB: 18,
    category: 'volatile-volatile',
    estimatedUsdValueA: 0.42,
    estimatedUsdValueB: 2110, // ETH ~$2110
    uniswapV3FeeTiers: [3000], // só fee3000 (fee10000 muito pequeno e cobra slippage alto)
    aerodromeStable: false,
    aerodromeVolatile: true,
  },
  // ─────────────────────────────────────────────────────────────────────
  //  VIRTUAL/WETH — AI agents (Virtuals Protocol)
  //  UniV3 fragmentado em 3 fee tiers (500+3000+10000 = $540k) vs Aero volatile=$4,7M
  //  Edge esperada: média — fragmentação UniV3 cria oportunidade de arb interna +
  //  desbalance vs Aero quando AI narrative pump/dump
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'VIRTUAL/WETH',
    tokenA: T.VIRTUAL,
    tokenB: T.WETH,
    decimalsA: 18,
    decimalsB: 18,
    category: 'volatile-volatile',
    estimatedUsdValueA: 0.69, // VIRTUAL ~$0.69 (snapshot 2026-05-23)
    estimatedUsdValueB: 2110,
    uniswapV3FeeTiers: [500, 3000], // fee500 é o maior ($375k); fee3000 ($100k) também viável
    aerodromeStable: false,
    aerodromeVolatile: true,
  },
];

/** Lookup helper (Base only, retrocompat). */
export function findPairById(id: string): TargetPair | undefined {
  return BASE_TARGET_PAIRS.find((p) => p.id === id);
}
