/**
 * Pares-alvo do backrun em Optimism mainnet — Sprint OP Expansion.
 *
 * Critérios de inclusão (mesma lógica do Base):
 *   1. Pool UniV3 com TVL ≥ $50k em pelo menos 1 fee tier
 *   2. Pool Velodrome (stable ou volatile) com TVL ≥ $50k
 *   3. Token volátil ou com fragmentação real (não-pegged)
 *   4. Fragmentação cross-DEX visível (TVL_A / TVL_B > 5x preferível)
 *
 * ⚠️ IMPORTANTE: Esses pares são candidatos INICIAIS baseados em pesquisa manual
 * 2026-05-26. Não passaram por backtest do scraper ainda. Quando Scraper Sprint 4
 * (backtest histórico) ficar pronto, esses pares vão ser validados — só sobrevivem
 * os de EV positivo provado.
 *
 * Conservador: começamos com universo restrito. Scraper de Fase 5 vai expandir.
 */

import type { Address } from 'viem';
import { OPTIMISM_MAINNET } from './optimism';
import type { TargetPair } from './target-pairs';

const T = OPTIMISM_MAINNET.tokens;

export const OPTIMISM_TARGET_PAIRS: TargetPair[] = [
  // ─────────────────────────────────────────────────────────────────────
  //  VELO/USDC — par estrela inicial
  //  Velodrome V2 volatile (>$2M TVL) vs UniV3 fee500 (~$50-200k)
  //  Edge esperada: alta — Velodrome domina, UniV3 demora a refletir
  //  ⚠️ Verificar TVL atual antes de ativar produção
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'VELO/USDC',
    tokenA: T.VELO as Address,
    tokenB: T.USDC as Address,
    decimalsA: 18,
    decimalsB: 6,
    category: 'volatile-stable',
    estimatedUsdValueA: 0.06, // VELO snapshot 2026-05-26 (volátil — atualizar antes deploy)
    estimatedUsdValueB: 1,
    uniswapV3FeeTiers: [500, 3000],
    aerodromeStable: false,
    aerodromeVolatile: true, // Velodrome usa mesma interface — flag funciona aqui
  },
  // ─────────────────────────────────────────────────────────────────────
  //  OP/USDC — governance token Optimism
  //  Velodrome volatile + UniV3 fee500 ambos com TVL alto
  //  Edge esperada: média — mais competido que VELO, mas volume diário alto
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'OP/USDC',
    tokenA: T.OP as Address,
    tokenB: T.USDC as Address,
    decimalsA: 18,
    decimalsB: 6,
    category: 'volatile-stable',
    estimatedUsdValueA: 0.85, // OP snapshot 2026-05-26
    estimatedUsdValueB: 1,
    uniswapV3FeeTiers: [500, 3000],
    aerodromeStable: false,
    aerodromeVolatile: true,
  },
  // ─────────────────────────────────────────────────────────────────────
  //  OP/WETH — par cross-volatile com volume diário alto
  //  Velodrome volatile + UniV3 fee3000 — pool mais profundo lado UniV3 nesse par
  //  Edge esperada: média — mais arb manual mas oportunidades aparecem em pump
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'OP/WETH',
    tokenA: T.OP as Address,
    tokenB: T.WETH as Address,
    decimalsA: 18,
    decimalsB: 18,
    category: 'volatile-volatile',
    estimatedUsdValueA: 0.85,
    estimatedUsdValueB: 2110,
    uniswapV3FeeTiers: [3000],
    aerodromeStable: false,
    aerodromeVolatile: true,
  },
  // ─────────────────────────────────────────────────────────────────────
  //  VELO/WETH — fechamento do ciclo
  //  Pool Velodrome volatile + UniV3 fee10000 (provavelmente)
  //  Edge esperada: alta — fee tier alto UniV3 = pool pequeno = oportunidades
  //  pós-whale grande em VELO
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'VELO/WETH',
    tokenA: T.VELO as Address,
    tokenB: T.WETH as Address,
    decimalsA: 18,
    decimalsB: 18,
    category: 'volatile-volatile',
    estimatedUsdValueA: 0.06,
    estimatedUsdValueB: 2110,
    uniswapV3FeeTiers: [3000, 10000],
    aerodromeStable: false,
    aerodromeVolatile: true,
  },
];

/** Lookup helper específico Optimism. */
export function findOptimismPairById(id: string): TargetPair | undefined {
  return OPTIMISM_TARGET_PAIRS.find((p) => p.id === id);
}
