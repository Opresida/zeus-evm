/**
 * ZEUS EVM — Discovery Scraper entrypoint.
 *
 * Sprint 1 (F2): descobre candidates pra backrun por chain, ranqueia via
 * composite score, gera report Discord + JSON.
 *
 * Fluxo:
 *   1. Pra cada chain ativa (SUPPORTED_CHAINS):
 *      a. Fetch top 200 pools via GeckoTerminal
 *      b. Agrupa pools por par (token0/token1 normalizado)
 *      c. Pra cada par com ≥2 DEXs, calcula TVL_dexA/TVL_dexB
 *      d. Aplica hard filters
 *      e. Score composite + ranking
 *   2. Salva JSON (latest + histórico)
 *   3. Envia Discord webhook se configurado
 *
 * CLI flags:
 *   --chain base       roda só Base
 *   --chain optimism   roda só Optimism
 *   --all              roda todas (default)
 *
 * Exit code 0 = OK, 1 = falha. Bom pra cron + observability.
 */

import { logger } from './logger';
import { loadConfig, SUPPORTED_CHAINS, type SupportedChain } from './config';
import { fetchPools, type GeckoPool } from './sources/geckoTerminal';
import { applyHardFilters, type CandidatePair } from './filters/hardFilters';
import { compositeScore } from './scoring/composite';
import { calcAgeDays } from './scoring/poolAge';
import { sendDiscordReport } from './output/reportDiscord';
import { writeJsonReport } from './output/reportJson';
import type { ScraperReport, RankedCandidate } from './output/types';
import { getTargetPairsForChain } from '@zeus-evm/chain-config';

interface AggregatedPair {
  pairKey: string; // chave canônica: addr1 + '_' + addr2 (sorted)
  pairId: string; // human readable: "AERO/USDC"
  baseTokenAddress: string;
  baseTokenSymbol: string;
  quoteTokenAddress: string;
  quoteTokenSymbol: string;
  pools: GeckoPool[];
}

/**
 * Normaliza um par de tokens em key canônica (lowercase, address sorted ascending).
 * Garante que pools UniV3/Aerodrome com mesma combinação token0/token1 colidam
 * no mesmo grupo.
 */
function pairKey(t0: string, t1: string): string {
  const a = t0.toLowerCase();
  const b = t1.toLowerCase();
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

function aggregatePoolsByPair(pools: GeckoPool[]): Map<string, AggregatedPair> {
  const map = new Map<string, AggregatedPair>();

  for (const pool of pools) {
    if (!pool.baseTokenAddress || !pool.quoteTokenAddress) continue;
    const key = pairKey(pool.baseTokenAddress, pool.quoteTokenAddress);

    const existing = map.get(key);
    if (existing) {
      existing.pools.push(pool);
    } else {
      map.set(key, {
        pairKey: key,
        pairId: `${pool.baseTokenSymbol}/${pool.quoteTokenSymbol}`,
        baseTokenAddress: pool.baseTokenAddress.toLowerCase(),
        baseTokenSymbol: pool.baseTokenSymbol,
        quoteTokenAddress: pool.quoteTokenAddress.toLowerCase(),
        quoteTokenSymbol: pool.quoteTokenSymbol,
        pools: [pool],
      });
    }
  }

  return map;
}

/**
 * Calcula candidato pronto pra scoring a partir de pools agregados de um par.
 * Retorna null se par tem só 1 DEX (sem fragmentação) ou se TVL zero.
 */
function buildCandidate(agg: AggregatedPair, knownPairIds: Set<string>): {
  candidate: CandidatePair;
  tvlDexA: number;
  tvlDexB: number;
  volumeUsd24h: number;
  priceChangePct24h: number;
  priceChangePct1h: number;
  ageDays: number;
  isNew: boolean;
  poolsInfo: RankedCandidate['pools'];
} | null {
  if (agg.pools.length < 2) return null;

  // Agrupa pools por DEX
  const tvlByDex = new Map<string, number>();
  const volumeByDex = new Map<string, number>();
  for (const pool of agg.pools) {
    const dex = pool.dexId || 'unknown';
    tvlByDex.set(dex, (tvlByDex.get(dex) ?? 0) + pool.reserveInUsd);
    volumeByDex.set(dex, (volumeByDex.get(dex) ?? 0) + pool.volumeUsd24h);
  }

  const dexes = Array.from(tvlByDex.entries()).sort((a, b) => b[1] - a[1]);
  if (dexes.length < 2) return null;

  const [largest, secondLargest] = dexes;
  if (!largest || !secondLargest) return null;
  const tvlDexA = largest[1];
  const tvlDexB = secondLargest[1];
  const totalTvl = Array.from(tvlByDex.values()).reduce((s, v) => s + v, 0);
  const totalVol = Array.from(volumeByDex.values()).reduce((s, v) => s + v, 0);

  if (totalTvl <= 0) return null;

  // Agregar volatility (média ponderada por TVL — pools maiores influenciam mais)
  let weightedPriceChange24h = 0;
  let weightedPriceChange1h = 0;
  let weightSum = 0;
  let oldestPoolDate: string | null = null;
  for (const pool of agg.pools) {
    const w = pool.reserveInUsd;
    if (w > 0) {
      weightedPriceChange24h += pool.priceChangePct24h * w;
      weightedPriceChange1h += pool.priceChangePct1h * w;
      weightSum += w;
    }
    if (pool.poolCreatedAt) {
      if (!oldestPoolDate || pool.poolCreatedAt < oldestPoolDate) {
        oldestPoolDate = pool.poolCreatedAt;
      }
    }
  }
  const priceChangePct24h = weightSum > 0 ? weightedPriceChange24h / weightSum : 0;
  const priceChangePct1h = weightSum > 0 ? weightedPriceChange1h / weightSum : 0;
  const ageDays = calcAgeDays(oldestPoolDate);

  const isNew = !knownPairIds.has(agg.pairId.toUpperCase()) &&
    !knownPairIds.has(`${agg.quoteTokenSymbol}/${agg.baseTokenSymbol}`.toUpperCase());

  const poolsInfo = agg.pools.map((p) => ({
    dexId: p.dexId,
    poolAddress: p.address,
    tvlUsd: p.reserveInUsd,
    volumeUsd24h: p.volumeUsd24h,
    feeTier: p.feeTier,
  }));

  return {
    candidate: {
      pairId: agg.pairId,
      totalTvlUsd: totalTvl,
      volumeUsd24h: totalVol,
      ageDays,
      baseTokenSymbol: agg.baseTokenSymbol,
      quoteTokenSymbol: agg.quoteTokenSymbol,
      baseTokenAddress: agg.baseTokenAddress,
      quoteTokenAddress: agg.quoteTokenAddress,
    },
    tvlDexA,
    tvlDexB,
    volumeUsd24h: totalVol,
    priceChangePct24h,
    priceChangePct1h,
    ageDays,
    isNew,
    poolsInfo,
  };
}

async function processChain(
  chain: SupportedChain,
  env: ReturnType<typeof loadConfig>,
): Promise<ScraperReport['results'][number]> {
  logger.info({ chain: chain.name, geckoNetwork: chain.geckoNetwork }, `🔍 Processando ${chain.name}`);

  // 1. Coleta pools via GeckoTerminal — top 100 (5 pages × 20)
  const pools = await fetchPools({
    network: chain.geckoNetwork,
    pages: 5,
    timeoutMs: env.SCRAPER_HTTP_TIMEOUT_MS,
    logger,
  });

  // 2. Agrupa por par
  const aggregated = aggregatePoolsByPair(pools);
  logger.info(
    { chain: chain.name, totalPools: pools.length, uniquePairs: aggregated.size },
    `📊 ${aggregated.size} pares únicos encontrados`,
  );

  // 3. Identifica pares JÁ conhecidos no target-pairs.ts da chain
  const knownTargets = getTargetPairsForChain(chain.chainId);
  const knownPairIds = new Set(knownTargets.map((t) => t.id.toUpperCase()));

  // 4. Pra cada par, build candidate + apply hard filters + score
  const ranked: RankedCandidate[] = [];
  let passedFilters = 0;

  for (const agg of aggregated.values()) {
    const built = buildCandidate(agg, knownPairIds);
    if (!built) continue;

    const filterResult = applyHardFilters(built.candidate, env);
    if (!filterResult.passed) {
      logger.debug({ pair: agg.pairId, reason: filterResult.reason }, 'filtered out');
      continue;
    }
    passedFilters++;

    const score = compositeScore({
      tvlDexA: built.tvlDexA,
      tvlDexB: built.tvlDexB,
      totalTvlUsd: built.candidate.totalTvlUsd,
      volumeUsd24h: built.volumeUsd24h,
      priceChangePct24h: built.priceChangePct24h,
      priceChangePct1h: built.priceChangePct1h,
      ageDays: built.ageDays,
      // competitionScore fica em default 50 (placeholder) até Sprint 2 (F4) ativar
    });

    ranked.push({
      pairId: agg.pairId,
      baseTokenAddress: agg.baseTokenAddress,
      quoteTokenAddress: agg.quoteTokenAddress,
      baseTokenSymbol: agg.baseTokenSymbol,
      quoteTokenSymbol: agg.quoteTokenSymbol,
      pools: built.poolsInfo,
      totalTvlUsd: built.candidate.totalTvlUsd,
      totalVolumeUsd24h: built.volumeUsd24h,
      score: score.total,
      breakdown: score.breakdown,
      isNew: built.isNew,
    });
  }

  // 5. Ordena por score desc + top N
  ranked.sort((a, b) => b.score - a.score);
  const topCandidates = ranked.slice(0, env.SCRAPER_TOP_N);

  logger.info(
    {
      chain: chain.name,
      considered: aggregated.size,
      passedFilters,
      topScore: topCandidates[0]?.score ?? 0,
      topPair: topCandidates[0]?.pairId,
      newCount: topCandidates.filter((c) => c.isNew).length,
    },
    `✅ ${chain.name}: ${topCandidates.length} top candidates`,
  );

  return {
    chainId: chain.chainId,
    chainName: chain.name,
    poolsCollected: pools.length,
    pairsConsidered: aggregated.size,
    pairsPassedFilters: passedFilters,
    topCandidates,
  };
}

function parseArgs(): { chains: readonly SupportedChain[] } {
  const args = process.argv.slice(2);
  const chainFlag = args.findIndex((a) => a === '--chain');
  const allFlag = args.includes('--all');

  if (chainFlag !== -1) {
    const name = args[chainFlag + 1]?.toLowerCase();
    const match = SUPPORTED_CHAINS.find(
      (c) => c.name.toLowerCase().includes(name ?? '') || c.geckoNetwork === name,
    );
    if (match) return { chains: [match] };
  }

  if (allFlag) return { chains: SUPPORTED_CHAINS };

  // Default: roda todas
  return { chains: SUPPORTED_CHAINS };
}

async function main() {
  const env = loadConfig();
  const { chains } = parseArgs();
  const startedAt = Date.now();

  logger.info(
    { chains: chains.map((c) => c.name), minTvl: env.SCRAPER_MIN_TVL_USD, topN: env.SCRAPER_TOP_N },
    `🚀 Discovery scraper boot — ${chains.length} chain(s)`,
  );

  const results: ScraperReport['results'] = [];
  for (const chain of chains) {
    try {
      const result = await processChain(chain, env);
      results.push(result);
    } catch (err) {
      logger.error(
        { chain: chain.name, err: err instanceof Error ? err.message : err },
        `Falha processando ${chain.name}`,
      );
    }
  }

  const report: ScraperReport = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    results,
  };

  // 6. Salva JSON
  writeJsonReport(report, { reportsDir: env.SCRAPER_REPORTS_DIR, logger });

  // 7. Envia Discord se configurado
  if (env.DISCORD_WEBHOOK_URL) {
    await sendDiscordReport(report, { webhookUrl: env.DISCORD_WEBHOOK_URL, logger });
  } else {
    logger.info(
      'DISCORD_WEBHOOK_URL não configurado — relatório salvo apenas em JSON',
    );
  }

  // 8. Console summary (sempre)
  for (const r of report.results) {
    console.log(`\n=== ${r.chainName} — Top ${r.topCandidates.length} ===`);
    if (r.topCandidates.length === 0) {
      console.log('(nenhum candidato passou filters)');
      continue;
    }
    for (let i = 0; i < r.topCandidates.length; i++) {
      const c = r.topCandidates[i]!;
      const tag = c.isNew ? ' ⭐NOVO' : '';
      console.log(
        `${i + 1}. ${c.pairId.padEnd(20)} score=${c.score.toFixed(1).padStart(5)}  ` +
        `frag=${c.breakdown.fragmentationRatio.toFixed(1)}x  ` +
        `TVL=$${(c.totalTvlUsd / 1_000).toFixed(0)}k  ` +
        `vol24h=$${(c.totalVolumeUsd24h / 1_000).toFixed(0)}k${tag}`,
      );
    }
  }

  logger.info(
    { elapsedMs: report.elapsedMs, totalChains: results.length },
    `🏁 Scraper concluído em ${(report.elapsedMs / 1000).toFixed(1)}s`,
  );

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'Scraper crashed at boot');
  process.exit(1);
});
