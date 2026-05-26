/**
 * DefiLlama source — cross-validation de TVL + acesso a yields/pools data.
 *
 * Docs: https://defillama.com/docs/api
 *
 * Endpoints úteis pra discovery:
 *   - GET https://yields.llama.fi/pools → todos os pools com APY + TVL + ageDays
 *   - GET https://coins.llama.fi/prices/current/{token-list} → preços agregados
 *
 * Sem auth. Sem rate limit publicado (gente respeita ~10 req/s).
 *
 * Uso primário aqui: validar TVL/volume reportado pelo GeckoTerminal contra DefiLlama.
 * Em casos onde divergem >30%, marcamos o par como "TVL_DISPUTED" e penalizamos no score.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

const DEFAULT_YIELDS_URL = 'https://yields.llama.fi';
const DEFAULT_COINS_URL = 'https://coins.llama.fi';

export interface LlamaPool {
  /** Pool ID interno DefiLlama */
  pool: string;
  /** Chain (ex: "Base", "Optimism") */
  chain: string;
  /** Protocol slug (ex: "aerodrome-v1", "uniswap-v3") */
  project: string;
  /** Symbol legível (ex: "AERO-USDC") */
  symbol: string;
  /** TVL USD */
  tvlUsd: number;
  /** APY base + reward (pode ser null) */
  apy: number | null;
  /** Quanto tempo o pool existe (dias) */
  ageDays?: number;
  /** Endereço do pool — opcional, nem todos retornam */
  underlyingTokens?: string[];
  poolMeta?: string | null;
}

export interface DefiLlamaParams {
  yieldsUrl?: string;
  timeoutMs?: number;
  logger?: LoggerLike;
}

/**
 * Busca TODOS pools que DefiLlama indexa (são ~10-15k). Caller filtra por chain.
 *
 * Custo: 1 request (~2-3MB JSON). Acontece 1x por execução do scraper.
 */
export async function fetchAllPools(params: DefiLlamaParams = {}): Promise<LlamaPool[]> {
  const yieldsUrl = params.yieldsUrl ?? DEFAULT_YIELDS_URL;
  const timeoutMs = params.timeoutMs ?? 30_000;
  const logger = params.logger;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${yieldsUrl}/pools`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger?.warn({ status: res.status }, `DefiLlama HTTP ${res.status}`);
      return [];
    }

    const json = (await res.json()) as { data?: Array<{
      pool: string;
      chain: string;
      project: string;
      symbol: string;
      tvlUsd: number;
      apy?: number;
      apyBase?: number;
      apyReward?: number;
      underlyingTokens?: string[];
      poolMeta?: string | null;
      // Idade não vem direta na response — temos que estimar via stablecoin/lpFee history
      // ou inferir da age de outras métricas. Pra MVP, deixamos undefined.
    }> };

    if (!json.data) {
      logger?.warn({}, 'DefiLlama response sem campo data');
      return [];
    }

    const pools: LlamaPool[] = json.data.map((p) => ({
      pool: p.pool,
      chain: p.chain,
      project: p.project,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd ?? 0,
      apy: p.apy ?? null,
      underlyingTokens: p.underlyingTokens,
      poolMeta: p.poolMeta ?? null,
    }));

    logger?.info({ totalPools: pools.length }, `📥 DefiLlama: ${pools.length} pools indexados`);
    return pools;
  } catch (err) {
    logger?.warn(
      { err: err instanceof Error ? err.message : err },
      'DefiLlama fetch falhou',
    );
    return [];
  }
}

/**
 * Filtra pools DefiLlama por chain identifier (case-insensitive).
 * Ex: filtra `chain === 'Base'` ou `'Optimism'`.
 */
export function filterPoolsByChain(pools: LlamaPool[], chainName: string): LlamaPool[] {
  const target = chainName.toLowerCase();
  return pools.filter((p) => p.chain.toLowerCase() === target);
}

/**
 * Estima ageDays via heurística: pools muito novos têm TVL volátil.
 * Sem dado real (DefiLlama não expõe), fallback default 30 dias (assume médio).
 * Quando integrarmos Etherscan API (busca block do deploy), refinamos isso.
 */
export function estimateAgeDays(pool: LlamaPool): number {
  // Heurística MVP: pools com TVL > $5M provavelmente têm > 30 dias.
  // Refinar quando integrar Etherscan getCreationBlock.
  if (pool.tvlUsd > 5_000_000) return 90;
  if (pool.tvlUsd > 1_000_000) return 60;
  if (pool.tvlUsd > 200_000) return 30;
  return 14; // pools menores, assume idade média baixa
}
