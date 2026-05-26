/**
 * GeckoTerminal source — pools por chain.
 *
 * Docs: https://www.geckoterminal.com/dex-api
 * Endpoint principal: GET /api/v2/networks/{network}/pools?page=N
 *
 * Sem auth. Rate limit 30 req/min na free tier (suficiente pra cron diário).
 * Pra paginar todos os pools de uma chain, ~5-10 páginas (cada página = 20 pools
 * ordenados por TVL desc). Pra MVP buscamos top 200 pools por chain = 10 páginas.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

const DEFAULT_BASE_URL = 'https://api.geckoterminal.com/api/v2';

export interface GeckoPool {
  /** Endereço do pool */
  address: string;
  /** Nome legível (ex: "AERO / USDC 0.05%") */
  name: string;
  /** DEX identifier (ex: "uniswap-v3", "aerodrome-base", "velodrome-v2") */
  dexId: string;
  /** Token0 address + symbol */
  baseTokenAddress: string;
  baseTokenSymbol: string;
  /** Token1 address + symbol */
  quoteTokenAddress: string;
  quoteTokenSymbol: string;
  /** TVL em USD */
  reserveInUsd: number;
  /** Volume 24h em USD */
  volumeUsd24h: number;
  /** Price change 24h em % (positivo ou negativo) */
  priceChangePct24h: number;
  /** Price change 1h em % */
  priceChangePct1h: number;
  /** Pool created at (ISO timestamp) */
  poolCreatedAt: string | null;
  /** Fee tier do pool (ex: "0.05%" pra UniV3 fee500). String porque varia DEX. */
  feeTier: string | null;
}

export interface GeckoTerminalParams {
  baseUrl?: string;
  network: string; // ex: "base", "optimism"
  /** Quantas páginas buscar. Cada página = 20 pools. Default 5 = top 100.
   *  Free tier limita ~30 req/min — 5 pages com 2.5s entre fica bem dentro. */
  pages?: number;
  /** Timeout ms */
  timeoutMs?: number;
  /** Delay entre páginas (ms). Default 2500. Free tier ~30 req/min. */
  pageDelayMs?: number;
  logger?: LoggerLike;
}

/**
 * Busca top N pools (ordenados por TVL desc) de uma chain.
 */
export async function fetchPools(params: GeckoTerminalParams): Promise<GeckoPool[]> {
  const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
  const pages = params.pages ?? 5;
  const timeoutMs = params.timeoutMs ?? 15_000;
  const pageDelayMs = params.pageDelayMs ?? 2_500;
  const logger = params.logger;

  const allPools: GeckoPool[] = [];

  for (let page = 1; page <= pages; page++) {
    const url = `${baseUrl}/networks/${params.network}/pools?page=${page}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        headers: { Accept: 'application/json;version=20230302' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        logger?.warn(
          { status: res.status, page, network: params.network },
          `GeckoTerminal HTTP ${res.status} na page=${page}`,
        );
        // 429 = rate limit. Aborta tudo, deixa caller reagir.
        if (res.status === 429) break;
        continue;
      }

      const json = (await res.json()) as { data?: Array<{
        id: string;
        attributes: {
          name: string;
          reserve_in_usd: string;
          volume_usd?: { h24?: string };
          price_change_percentage?: { h1?: string; h24?: string };
          pool_created_at?: string | null;
        };
        relationships?: {
          base_token?: { data?: { id: string } };
          quote_token?: { data?: { id: string } };
          dex?: { data?: { id: string } };
        };
      }> };

      if (!json.data || json.data.length === 0) break;

      for (const item of json.data) {
        const name = item.attributes.name ?? '';
        const reserveInUsd = parseFloat(item.attributes.reserve_in_usd ?? '0');
        const volumeUsd24h = parseFloat(item.attributes.volume_usd?.h24 ?? '0');
        const priceChangePct24h = parseFloat(item.attributes.price_change_percentage?.h24 ?? '0');
        const priceChangePct1h = parseFloat(item.attributes.price_change_percentage?.h1 ?? '0');

        // address vem em `id` no formato "network_chainid_pooladdress"
        // Ex: "base_0x...". Extraímos só o address.
        const idParts = item.id.split('_');
        const poolAddress = idParts[idParts.length - 1] ?? item.id;

        // Tokens vêm em relationships — id no formato "network_address"
        const baseTokenId = item.relationships?.base_token?.data?.id ?? '';
        const quoteTokenId = item.relationships?.quote_token?.data?.id ?? '';
        const baseTokenAddr = baseTokenId.split('_').pop() ?? '';
        const quoteTokenAddr = quoteTokenId.split('_').pop() ?? '';

        // Extrai symbols do nome "TOKENA / TOKENB feeTier"
        const symbolMatch = name.match(/^(\S+)\s*\/\s*(\S+)/);
        const baseSymbol = symbolMatch?.[1] ?? '?';
        const quoteSymbol = symbolMatch?.[2] ?? '?';

        // Fee tier — extrai de "AERO / USDC 0.05%" → "0.05%"
        const feeMatch = name.match(/(\d+\.\d+%)|(\d+%)/);
        const feeTier = feeMatch?.[0] ?? null;

        const dexId = item.relationships?.dex?.data?.id ?? '';

        allPools.push({
          address: poolAddress,
          name,
          dexId,
          baseTokenAddress: baseTokenAddr,
          baseTokenSymbol: baseSymbol,
          quoteTokenAddress: quoteTokenAddr,
          quoteTokenSymbol: quoteSymbol,
          reserveInUsd,
          volumeUsd24h,
          priceChangePct24h,
          priceChangePct1h,
          poolCreatedAt: item.attributes.pool_created_at ?? null,
          feeTier,
        });
      }

      logger?.debug(
        { page, network: params.network, fetched: json.data.length, accumulated: allPools.length },
        `GeckoTerminal page ${page} OK`,
      );

      if (page < pages) {
        await sleep(pageDelayMs);
      }
    } catch (err) {
      logger?.warn(
        { err: err instanceof Error ? err.message : err, page, network: params.network },
        `GeckoTerminal fetch falhou page=${page}`,
      );
    }
  }

  logger?.info(
    { network: params.network, totalPools: allPools.length, pages },
    `📥 GeckoTerminal: ${allPools.length} pools coletados em ${params.network}`,
  );

  return allPools;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
