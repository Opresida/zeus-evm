/**
 * Hard filters — eliminam pares antes do composite scoring.
 *
 * Filtra:
 *   1. TVL agregado abaixo do mínimo (slippage massiva em flashloan)
 *   2. Volume 24h abaixo do mínimo (sem whales = sem oportunidades)
 *   3. Pool idade < 7 dias (rug risk)
 *   4. Pares stable-stable (USDC/USDT — sem volatility/edge)
 *   5. Pools com tokens em allowlist NEGATIVA (rugados conhecidos, scams, etc)
 *
 * Sobreviventes vão pro scoring.
 */

import type { ScraperEnv } from '../config';

export interface CandidatePair {
  pairId: string;
  totalTvlUsd: number;
  volumeUsd24h: number;
  ageDays: number;
  baseTokenSymbol: string;
  quoteTokenSymbol: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
}

export interface FilterResult {
  passed: boolean;
  reason?: string;
}

/**
 * Symbols de stablecoins conhecidos — pares stable-stable são rejeitados.
 * Lista propositalmente conservadora; quando o token tá fora dela, considera-se volátil.
 */
const KNOWN_STABLES = new Set([
  'USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'EURC', 'GHO',
  'FRAX', 'LUSD', 'CRVUSD', 'MIM', 'TUSD', 'PYUSD',
]);

/**
 * Lista NEGATIVA — tokens conhecidos por rug, exploit, ou volume falso.
 * Manter atualizada via incidents observed. Por padrão começa vazia.
 */
const TOKEN_BLOCKLIST = new Set<string>([
  // Adicionar address lowercase quando descobrirmos tokens problemáticos
]);

export function applyHardFilters(
  candidate: CandidatePair,
  env: Pick<ScraperEnv, 'SCRAPER_MIN_TVL_USD' | 'SCRAPER_MIN_VOLUME_24H_USD' | 'SCRAPER_MIN_POOL_AGE_DAYS'>,
): FilterResult {
  // 1. TVL mínimo
  if (candidate.totalTvlUsd < env.SCRAPER_MIN_TVL_USD) {
    return {
      passed: false,
      reason: `TVL $${candidate.totalTvlUsd.toFixed(0)} < min $${env.SCRAPER_MIN_TVL_USD}`,
    };
  }

  // 2. Volume mínimo
  if (candidate.volumeUsd24h < env.SCRAPER_MIN_VOLUME_24H_USD) {
    return {
      passed: false,
      reason: `volume24h $${candidate.volumeUsd24h.toFixed(0)} < min $${env.SCRAPER_MIN_VOLUME_24H_USD}`,
    };
  }

  // 3. Idade mínima
  if (candidate.ageDays < env.SCRAPER_MIN_POOL_AGE_DAYS) {
    return {
      passed: false,
      reason: `idade ${candidate.ageDays}d < min ${env.SCRAPER_MIN_POOL_AGE_DAYS}d (rug risk)`,
    };
  }

  // 4. Pares stable-stable
  const baseUpper = candidate.baseTokenSymbol.toUpperCase();
  const quoteUpper = candidate.quoteTokenSymbol.toUpperCase();
  if (KNOWN_STABLES.has(baseUpper) && KNOWN_STABLES.has(quoteUpper)) {
    return {
      passed: false,
      reason: `par stable-stable (${baseUpper}/${quoteUpper}) — sem volatility/edge`,
    };
  }

  // 5. Tokens em blocklist
  const baseAddr = candidate.baseTokenAddress.toLowerCase();
  const quoteAddr = candidate.quoteTokenAddress.toLowerCase();
  if (TOKEN_BLOCKLIST.has(baseAddr) || TOKEN_BLOCKLIST.has(quoteAddr)) {
    return {
      passed: false,
      reason: `token em blocklist (rug/scam/wash)`,
    };
  }

  return { passed: true };
}

export { KNOWN_STABLES };
