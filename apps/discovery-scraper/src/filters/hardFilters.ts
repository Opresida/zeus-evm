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
  /** TVL do DEX maior (pra detecção pool morto). */
  tvlLargestDex: number;
  /** TVL do DEX menor (pra detecção pool morto). */
  tvlSecondLargestDex: number;
  /** Fragmentação ratio (= tvlLargestDex / tvlSecondLargestDex). */
  fragmentationRatio: number;
}

export interface FilterResult {
  passed: boolean;
  reason?: string;
}

/** Limites configuráveis pros filtros novos. */
const POOL_DEAD_TVL_MIN = 10_000; // se TVL do menor DEX < $10k, é pool morto
const WASH_TRADING_GIRO_MAX = 10; // se vol24h/TVL > 10, é wash trading
const FRAGMENTATION_ARTIFACT_MAX = 1000; // fragmentação > 1000x é artefato

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
  // 1. TVL agregado mínimo
  if (candidate.totalTvlUsd < env.SCRAPER_MIN_TVL_USD) {
    return {
      passed: false,
      reason: `TVL $${candidate.totalTvlUsd.toFixed(0)} < min $${env.SCRAPER_MIN_TVL_USD}`,
    };
  }

  // 2. Volume 24h mínimo
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

  // 6. NOVO: Pool morto — DEX secundário tem TVL ridiculamente baixo
  // Sinal de pool fantasma (ex: LGNS/DAI Polygon com $367M de um lado e $50 do outro).
  // Não tem edge real — só slippage 99% se tentarmos usar o lado morto.
  if (candidate.tvlSecondLargestDex < POOL_DEAD_TVL_MIN) {
    return {
      passed: false,
      reason: `pool morto: DEX secundário com TVL $${candidate.tvlSecondLargestDex.toFixed(0)} < $${POOL_DEAD_TVL_MIN}`,
    };
  }

  // 7. NOVO: Wash trading — giro diário absurdo
  // Volume saudável: 5-15% do TVL diário. Acima de 1000% (10x giro) = wash trading.
  if (candidate.totalTvlUsd > 0) {
    const giroRatio = candidate.volumeUsd24h / candidate.totalTvlUsd;
    if (giroRatio > WASH_TRADING_GIRO_MAX) {
      return {
        passed: false,
        reason: `wash trading suspeito: giro ${giroRatio.toFixed(1)}x diário (>${WASH_TRADING_GIRO_MAX}x)`,
      };
    }
  }

  // 8. NOVO: Fragmentação artefato — > 1000x é sinal de pool morto ou bug de API
  if (candidate.fragmentationRatio > FRAGMENTATION_ARTIFACT_MAX) {
    return {
      passed: false,
      reason: `fragmentação ${candidate.fragmentationRatio.toFixed(0)}x > ${FRAGMENTATION_ARTIFACT_MAX}x (artefato/pool morto)`,
    };
  }

  return { passed: true };
}

/**
 * Detecta se 2 DEX IDs do GeckoTerminal pertencem ao mesmo protocolo em versões
 * diferentes (ex: uniswap-v3 + uniswap-v4 — mesmo team, sem edge real).
 *
 * Quando true, esses 2 DEXs devem ser MERGEADOS num bucket único no cálculo
 * de fragmentação (caller agrega TVL antes de comparar).
 */
export function isSameDexFamily(dexIdA: string, dexIdB: string): boolean {
  const normalize = (id: string): string => {
    const lower = id.toLowerCase();
    // Remove versão sufixo: "uniswap-v3" → "uniswap", "aerodrome-slipstream" → "aerodrome"
    return lower
      .replace(/-v\d+$/, '')
      .replace(/-slipstream$/, '')
      .replace(/-cl$/, '') // concentrated liquidity variants
      .replace(/-classic$/, '');
  };
  return normalize(dexIdA) === normalize(dexIdB);
}

export { KNOWN_STABLES };
