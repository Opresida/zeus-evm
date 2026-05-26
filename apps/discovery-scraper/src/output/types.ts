/**
 * Tipos compartilhados pelo orchestrator e formatters de output.
 */

import type { CompositeBreakdown } from '../scoring/composite';

export interface RankedCandidate {
  /** Identifier semântico do par (ex: "AERO/USDC"). */
  pairId: string;
  /** Address dos 2 tokens, lowercase. */
  baseTokenAddress: string;
  quoteTokenAddress: string;
  baseTokenSymbol: string;
  quoteTokenSymbol: string;
  /** Endereços dos pools em cada DEX (pelo menos 2 pra fragmentação). */
  pools: Array<{
    dexId: string;
    poolAddress: string;
    tvlUsd: number;
    volumeUsd24h: number;
    feeTier: string | null;
  }>;
  /** TVL agregado. */
  totalTvlUsd: number;
  /** Volume 24h agregado. */
  totalVolumeUsd24h: number;
  /** Score 0-100. */
  score: number;
  /** Breakdown por dimensão. */
  breakdown: CompositeBreakdown;
  /** True quando esse par AINDA NÃO está no target-pairs.ts (oportunidade descoberta). */
  isNew: boolean;
}

export interface ScraperReport {
  /** ISO timestamp da execução. */
  generatedAt: string;
  /** Quanto durou. */
  elapsedMs: number;
  results: Array<{
    chainId: number;
    chainName: string;
    /** Total de pools brutos coletados (antes de qualquer filtro). */
    poolsCollected: number;
    /** Pares únicos (agregados por token0/token1) considerados. */
    pairsConsidered: number;
    /** Pares que passaram pelos hard filters. */
    pairsPassedFilters: number;
    /** Top N candidates ranked por score. */
    topCandidates: RankedCandidate[];
  }>;
}
