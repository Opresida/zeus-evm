/**
 * ZEUS EVM — Discovery Scraper entrypoint (F2.11 — filtros refinados + token safety).
 *
 * Fluxo:
 *   1. Carrega state.json (controle: enabled, chains ativas)
 *   2. Pra cada chain ativa:
 *      a. Fetch top N pools (300 chains backrun-active, 100 chains intel)
 *      b. Agrupa pools por par (com merge de mesma família DEX — UniV3+UniV4 = 1 bucket)
 *      c. Aplica hard filters de mercado (TVL, vol, idade, stable-stable, pool morto, wash, frag>1000x)
 *      d. Carrega token safety (GoPlus + CoinGecko com cache)
 *      e. Aplica hard filters de safety (honeypot, tax, mintable, holders, top holder, creator)
 *      f. Composite scoring (pesos rebalanceados + boosts/penalties)
 *      g. Top N ranqueados
 *   3. Salva JSON + envia Discord
 *   4. Persiste state com stats da execução
 */

import { logger } from './logger';
import { loadConfig, SUPPORTED_CHAINS, type SupportedChain } from './config';
import { fetchPools, type GeckoPool } from './sources/geckoTerminal';
import {
  fetchTokenSafety,
  initCache as initSafetyCache,
  flushCache as flushSafetyCache,
  cacheStats as safetyCacheStats,
  type TokenSafety,
} from './sources/tokenSafety';
import { applyHardFilters, isSameDexFamily, type CandidatePair } from './filters/hardFilters';
import { applyPairSafetyFilters } from './filters/tokenSafetyFilters';
import { compositeScore } from './scoring/composite';
import { calcAgeDays } from './scoring/poolAge';
import { sendDiscordReport } from './output/reportDiscord';
import { writeJsonReport } from './output/reportJson';
import type { ScraperReport, RankedCandidate } from './output/types';
import { getTargetPairsForChain } from '@zeus-evm/chain-config';
import { StateManager } from './state';

interface AggregatedPair {
  pairKey: string;
  pairId: string;
  baseTokenAddress: string;
  baseTokenSymbol: string;
  quoteTokenAddress: string;
  quoteTokenSymbol: string;
  pools: GeckoPool[];
}

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
 * Agrupa pools em "famílias de DEX" (UniV3 + UniV4 = mesma família = 1 bucket).
 * Isso evita contar fragmentação artificial entre versões do mesmo protocolo.
 */
function bucketPoolsByDexFamily(pools: GeckoPool[]): Map<string, { tvl: number; volume: number; dexIds: string[] }> {
  const buckets = new Map<string, { tvl: number; volume: number; dexIds: string[] }>();
  for (const pool of pools) {
    // Procura bucket existente que pertence à mesma família
    let bucketKey = pool.dexId;
    for (const existing of buckets.keys()) {
      if (isSameDexFamily(existing, pool.dexId)) {
        bucketKey = existing;
        break;
      }
    }
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.tvl += pool.reserveInUsd;
      bucket.volume += pool.volumeUsd24h;
      if (!bucket.dexIds.includes(pool.dexId)) bucket.dexIds.push(pool.dexId);
    } else {
      buckets.set(bucketKey, {
        tvl: pool.reserveInUsd,
        volume: pool.volumeUsd24h,
        dexIds: [pool.dexId],
      });
    }
  }
  return buckets;
}

interface PreparedCandidate {
  candidate: CandidatePair;
  tvlDexA: number;
  tvlDexB: number;
  volumeUsd24h: number;
  priceChangePct24h: number;
  priceChangePct1h: number;
  ageDays: number;
  isNew: boolean;
  poolsInfo: RankedCandidate['pools'];
}

function buildCandidate(agg: AggregatedPair, knownPairIds: Set<string>): PreparedCandidate | null {
  // Bucket por família DEX antes de comparar
  const buckets = bucketPoolsByDexFamily(agg.pools);
  if (buckets.size < 2) return null; // sem fragmentação real cross-DEX

  const sortedBuckets = Array.from(buckets.values()).sort((a, b) => b.tvl - a.tvl);
  const [largest, second] = sortedBuckets;
  if (!largest || !second) return null;

  const tvlDexA = largest.tvl;
  const tvlDexB = second.tvl;
  const totalTvl = sortedBuckets.reduce((s, b) => s + b.tvl, 0);
  const totalVol = sortedBuckets.reduce((s, b) => s + b.volume, 0);

  if (totalTvl <= 0) return null;

  // Volatility ponderado por TVL
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
      if (!oldestPoolDate || pool.poolCreatedAt < oldestPoolDate) oldestPoolDate = pool.poolCreatedAt;
    }
  }
  const priceChangePct24h = weightSum > 0 ? weightedPriceChange24h / weightSum : 0;
  const priceChangePct1h = weightSum > 0 ? weightedPriceChange1h / weightSum : 0;
  const ageDays = calcAgeDays(oldestPoolDate);

  const fragmentationRatio = tvlDexB > 0 ? tvlDexA / tvlDexB : 0;

  const isNew =
    !knownPairIds.has(agg.pairId.toUpperCase()) &&
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
      tvlLargestDex: tvlDexA,
      tvlSecondLargestDex: tvlDexB,
      fragmentationRatio,
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
  const tagDeep = chain.isBackrunActive ? ' (deep)' : ' (intel)';
  logger.info(
    { chain: chain.name, poolPages: chain.poolPages, isBackrunActive: chain.isBackrunActive },
    `🔍 Processando ${chain.name}${tagDeep}`,
  );

  // 1. GeckoTerminal pools
  const pools = await fetchPools({
    network: chain.geckoNetwork,
    pages: chain.poolPages,
    timeoutMs: env.SCRAPER_HTTP_TIMEOUT_MS,
    logger,
  });

  // 2. Agrega por par
  const aggregated = aggregatePoolsByPair(pools);
  logger.info(
    { chain: chain.name, totalPools: pools.length, uniquePairs: aggregated.size },
    `📊 ${aggregated.size} pares únicos`,
  );

  // 3. Pares conhecidos pra tag ⭐NOVO
  const knownTargets = getTargetPairsForChain(chain.chainId);
  const knownPairIds = new Set(knownTargets.map((t) => t.id.toUpperCase()));

  // 4. Constrói candidates + aplica hard filters de mercado
  const candidatesMarket: PreparedCandidate[] = [];
  let droppedMarket = 0;
  for (const agg of aggregated.values()) {
    const built = buildCandidate(agg, knownPairIds);
    if (!built) {
      droppedMarket++;
      continue;
    }
    const r = applyHardFilters(built.candidate, env);
    if (!r.passed) {
      logger.debug({ pair: agg.pairId, reason: r.reason }, 'filtered out (market)');
      droppedMarket++;
      continue;
    }
    candidatesMarket.push(built);
  }
  logger.info(
    { chain: chain.name, passedMarket: candidatesMarket.length, droppedMarket },
    `🪧 ${candidatesMarket.length} passaram filtros de mercado (${droppedMarket} eliminados)`,
  );

  // 5. Carrega token safety (batch — economiza calls)
  const uniqueTokens = new Set<string>();
  for (const c of candidatesMarket) {
    uniqueTokens.add(c.candidate.baseTokenAddress);
    uniqueTokens.add(c.candidate.quoteTokenAddress);
  }
  let safetyByAddr = new Map<string, TokenSafety>();
  if (uniqueTokens.size > 0) {
    const safetyList = await fetchTokenSafety({
      chainId: chain.chainId,
      addresses: Array.from(uniqueTokens),
      timeoutMs: env.SCRAPER_HTTP_TIMEOUT_MS,
      logger,
    });
    safetyByAddr = new Map(safetyList.map((s) => [s.address.toLowerCase(), s]));
    logger.info(
      { chain: chain.name, tokensChecked: safetyList.length },
      `🔒 ${safetyList.length} tokens verificados via GoPlus + CoinGecko`,
    );
  }

  // 6. Aplica safety filters + score composite
  const ranked: RankedCandidate[] = [];
  let droppedSafety = 0;
  for (const c of candidatesMarket) {
    const baseSafety = safetyByAddr.get(c.candidate.baseTokenAddress);
    const quoteSafety = safetyByAddr.get(c.candidate.quoteTokenAddress);

    if (baseSafety && quoteSafety) {
      const safetyResult = applyPairSafetyFilters(baseSafety, quoteSafety);
      if (!safetyResult.passed) {
        logger.debug({ pair: c.candidate.pairId, reason: safetyResult.reason }, 'filtered out (safety)');
        droppedSafety++;
        continue;
      }
    }

    const score = compositeScore({
      tvlDexA: c.tvlDexA,
      tvlDexB: c.tvlDexB,
      totalTvlUsd: c.candidate.totalTvlUsd,
      volumeUsd24h: c.volumeUsd24h,
      priceChangePct24h: c.priceChangePct24h,
      priceChangePct1h: c.priceChangePct1h,
      ageDays: c.ageDays,
      baseTokenSafety: baseSafety,
      quoteTokenSafety: quoteSafety,
    });

    ranked.push({
      pairId: c.candidate.pairId,
      baseTokenAddress: c.candidate.baseTokenAddress,
      quoteTokenAddress: c.candidate.quoteTokenAddress,
      baseTokenSymbol: c.candidate.baseTokenSymbol,
      quoteTokenSymbol: c.candidate.quoteTokenSymbol,
      pools: c.poolsInfo,
      totalTvlUsd: c.candidate.totalTvlUsd,
      totalVolumeUsd24h: c.volumeUsd24h,
      score: score.total,
      breakdown: score.breakdown,
      isNew: c.isNew,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  const topCandidates = ranked.slice(0, env.SCRAPER_TOP_N);

  logger.info(
    {
      chain: chain.name,
      considered: aggregated.size,
      passedMarket: candidatesMarket.length,
      droppedSafety,
      qualified: ranked.length,
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
    pairsPassedFilters: ranked.length,
    topCandidates,
  };
}

function parseArgs(): { chains: readonly SupportedChain[] | null } {
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
  if (allFlag) return { chains: null }; // null = usar state.activeChains
  return { chains: null };
}

async function main() {
  const env = loadConfig();
  const stateManager = new StateManager(env.SCRAPER_STATE_PATH, logger);
  initSafetyCache(env.SCRAPER_CACHE_DIR);

  const startedAt = Date.now();
  const cliArgs = parseArgs();

  // Decide quais chains rodar:
  //   - Se CLI flag --chain X, sempre roda X (override do state)
  //   - Senão, usa state.activeChains
  let chains: readonly SupportedChain[];
  if (cliArgs.chains) {
    chains = cliArgs.chains;
  } else {
    const stateChains = stateManager.getActiveChains();
    chains = SUPPORTED_CHAINS.filter((c) => stateChains.includes(c.geckoNetwork));
  }

  // Respeita state.enabled (front-end vai poder ligar/desligar via API)
  if (!stateManager.isEnabled() && cliArgs.chains === null) {
    logger.warn({ state: stateManager.get() }, '⏸️ Scraper DESATIVADO via state.json — skip run');
    process.exit(0);
  }

  logger.info(
    {
      chains: chains.map((c) => c.name),
      minTvl: env.SCRAPER_MIN_TVL_USD,
      topN: env.SCRAPER_TOP_N,
      schedule: stateManager.get().schedule,
    },
    `🚀 Discovery scraper boot — ${chains.length} chain(s) ativas`,
  );

  const results: ScraperReport['results'] = [];
  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i]!;
    try {
      const result = await processChain(chain, env);
      results.push(result);
    } catch (err) {
      logger.error(
        { chain: chain.name, err: err instanceof Error ? err.message : err },
        `Falha processando ${chain.name}`,
      );
    }
    if (i < chains.length - 1) {
      logger.info({ nextChain: chains[i + 1]?.name }, '⏸️ Pausa 5s entre chains...');
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }

  // Flush cache token safety pra disco antes de continuar
  flushSafetyCache();
  const cstat = safetyCacheStats();
  logger.info({ entries: cstat.entries, fresh: cstat.freshEntries }, '💾 Cache safety persistido');

  const report: ScraperReport = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    results,
  };

  writeJsonReport(report, { reportsDir: env.SCRAPER_REPORTS_DIR, logger });

  if (env.DISCORD_WEBHOOK_URL) {
    await sendDiscordReport(report, { webhookUrl: env.DISCORD_WEBHOOK_URL, logger });
  } else {
    logger.info('DISCORD_WEBHOOK_URL não configurado — relatório salvo apenas em JSON');
  }

  // Console summary
  for (const r of report.results) {
    console.log(`\n=== ${r.chainName} — Top ${r.topCandidates.length} ===`);
    if (r.topCandidates.length === 0) {
      console.log('(nenhum candidato passou filters)');
      continue;
    }
    for (let i = 0; i < r.topCandidates.length; i++) {
      const c = r.topCandidates[i]!;
      const tag = c.isNew ? ' ⭐NOVO' : '';
      const cex = c.breakdown.softAdjustmentsDetails.some((d) => d.includes('CEX')) ? ' 💼CEX' : '';
      console.log(
        `${(i + 1).toString().padStart(2)}. ${c.pairId.padEnd(22)} score=${c.score.toFixed(1).padStart(5)}  ` +
          `frag=${c.breakdown.fragmentationRatio.toFixed(1)}x  ` +
          `TVL=$${(c.totalTvlUsd / 1_000).toFixed(0)}k  ` +
          `vol=$${(c.totalVolumeUsd24h / 1_000).toFixed(0)}k${tag}${cex}`,
      );
    }
  }

  // Atualiza state
  const allTopCandidates = report.results.flatMap((r) => r.topCandidates);
  const topGlobal = allTopCandidates.reduce<RankedCandidate | null>(
    (acc, c) => (acc === null || c.score > acc.score ? c : acc),
    null,
  );
  stateManager.updateAfterRun({
    poolsAnalyzed: report.results.reduce((s, r) => s + r.poolsCollected, 0),
    candidatesQualified: report.results.reduce((s, r) => s + r.pairsPassedFilters, 0),
    newDiscoveries: allTopCandidates.filter((c) => c.isNew).length,
    topScore: topGlobal?.score ?? 0,
    topPair: topGlobal?.pairId ?? null,
  });

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
