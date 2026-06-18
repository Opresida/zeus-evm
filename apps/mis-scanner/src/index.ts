/**
 * MIS Scanner — varredura de ineficiências de mercado (Motor 2).
 *
 * Padrão de uso atual (sem VM 24/7): rodar ao chegar, deixar varrendo até sair.
 * O histórico é PERSISTIDO em disco (snapshot JSON) — ao reiniciar amanhã, recarrega
 * e continua acumulando. A persistência (sinal-chave do MIS) cresce dia após dia.
 *
 * Próximo passo: deploy 24/7 na Fly.io.
 *
 * Roda em OBSERVAÇÃO PURA — sem capital, sem submeter tx. Só lê estado on-chain,
 * calcula divergências locais e ranqueia por persistência.
 *
 *   pnpm --filter @zeus-evm/mis-scanner start
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import dotenv from 'dotenv';
import { createPublicClient, createWalletClient, http, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, avalanche } from 'viem/chains';
import pino from 'pino';

import { BASE_MAINNET, AVALANCHE_MAINNET, type ChainConfig } from '@zeus-evm/chain-config';
import {
  MarketInefficiencyScanner,
  TimeseriesStore,
  buildObservationEvent,
  resolveIntelligenceDbPath,
  MetricRegistry,
  registerStandardMetrics,
  DimensionMetricsExporter,
  startHealthServer,
  GasOracle,
  EventBus,
  EventIngester,
  SenderRegistry,
  BlockHistoryScanner,
  CooccurrenceAnalyzer,
  BuilderAttributionTracker,
  PnlTracker,
  FailureTracker,
  PnlReconciler,
  PnlAggregator,
  CalibrationDriftTracker,
  FailureCollector,
  CompetitorResolver,
  BlockPositionTracker,
  computeAdaptiveThresholds,
  type InefficiencyObservation,
  type PoolGroup,
} from '@zeus-evm/execution-utils';
import {
  BASE_CURATED_PAIRS,
  AVALANCHE_CURATED_PAIRS,
  curatedPairsToResolved,
  dedupPairs,
  resolvePoolGroups,
  type ResolvedPair,
} from './poolGroups';
import { deriveProtocolTokens, buildDerivedPairs } from './deriveTokens';
import { optimizeFlashLoan, fetchEthUsd, fetchTokenUsd } from './flashEstimator';
import { loadConfig } from './config';
import { findFreshArb } from './execution/arbOpportunity';
import { dispatchArb, type ArbDispatchDeps } from './execution/arbDispatcher';

// Carrega .env local + raiz do monorepo (2 níveis acima) — RPC fica na raiz
dotenv.config();
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env') });

const logger = pino({ transport: { target: 'pino-pretty' } });

// Config validada (zod) — falha no boot com erro claro se algo estiver malformado (sem setInterval(NaN)).
const env = loadConfig();
const SCAN_INTERVAL_MS = env.MIS_SCAN_INTERVAL_MS; // ~1 bloco
// Dir do snapshot — honra MIS_SNAPSHOT_DIR (volume persistente na Fly.io) ou logs/mis local.
const SNAPSHOT_DIR = env.MIS_SNAPSHOT_DIR ?? resolve(process.cwd(), 'logs', 'mis');
const RANKING_EVERY = env.MIS_RANKING_EVERY; // loga ranking a cada N scans

/** Chains suportadas pelo scanner. Seleção via env MIS_CHAIN (default base). */
const CHAINS: Record<string, { cfg: ChainConfig; viem: typeof base; rpc: string | undefined; pairs: typeof BASE_CURATED_PAIRS; snapshot: string }> = {
  base: { cfg: BASE_MAINNET, viem: base, rpc: env.BASE_RPC_HTTP, pairs: BASE_CURATED_PAIRS, snapshot: 'base-mis-snapshot.json' },
  avalanche: { cfg: AVALANCHE_MAINNET, viem: avalanche as unknown as typeof base, rpc: env.AVALANCHE_RPC_HTTP, pairs: AVALANCHE_CURATED_PAIRS, snapshot: 'avalanche-mis-snapshot.json' },
};

function loadSnapshot(path: string): Record<string, InefficiencyObservation[]> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'snapshot corrompido — começando vazio');
    return null;
  }
}

function saveSnapshot(path: string, data: Record<string, InefficiencyObservation[]>): void {
  try {
    if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(data), 'utf-8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'erro salvando snapshot');
  }
}

async function main(): Promise<void> {
  const chainKey = env.MIS_CHAIN;
  const sel = CHAINS[chainKey];
  if (!sel) {
    logger.fatal({ chainKey, supported: Object.keys(CHAINS) }, 'MIS_CHAIN não suportada');
    process.exit(1);
  }
  if (!sel.rpc) {
    logger.fatal(`RPC não definido pra ${chainKey} no .env — MIS precisa de RPC pra ler pools`);
    process.exit(1);
  }
  const chainConfig = sel.cfg;
  const SNAPSHOT_PATH = resolve(SNAPSHOT_DIR, sel.snapshot);
  logger.info({ chain: chainKey }, `⛓️  MIS na chain: ${chainKey}`);

  const client = createPublicClient({ chain: sel.viem, transport: http(sel.rpc) });

  // Conta do bot (derivada da chave EXCLUSIVA, se houver) — reusada na inteligência + execução.
  const ZERO = '0x0000000000000000000000000000000000000000' as Address;
  const botAccount: Address = env.EXECUTOR_PRIVATE_KEY
    ? privateKeyToAccount(env.EXECUTOR_PRIVATE_KEY as `0x${string}`).address
    : ZERO;

  // MIS com window de 7 dias (persistência precisa de tempo) + snapshot a cada sample
  const minDivergenceBps = env.MIS_MIN_DIVERGENCE_BPS;
  const mis = new MarketInefficiencyScanner({
    minDivergenceBps,
    windowMs: 7 * 24 * 60 * 60 * 1000,
  });

  // ─── Ledger OIE (DuckDB) — grava ineficiências viáveis pro ranking empírico de pares ───
  // Arquivo próprio (DuckDB é single-writer); unificação cross-motor é na consulta (ATTACH).
  const store = new TimeseriesStore({
    dbPath: resolveIntelligenceDbPath('intelligence-mis.duckdb'),
    logger,
  });
  await store.init();

  // ─── Camada de inteligência (Parte B) — espelha o liquidator/backrun no Motor 2 ───
  const eventBus = new EventBus(logger);
  const eventIngester = new EventIngester({ store, eventBus, logger, defaultChain: chainConfig.name });
  eventIngester.start();
  // Competidores (arb é competitivo — o motor TEM que ver o adversário).
  const senderRegistry = new SenderRegistry({ baseDir: resolve('logs', 'competitors'), logger });
  const cooccurrence = new CooccurrenceAnalyzer();
  const builderAttribution = new BuilderAttributionTracker({ ourAccount: botAccount, logger });
  const intelTargets = {
    aave_v3_pool: chainConfig.aave?.pool,
    compound_comets: [chainConfig.compoundV3?.cUSDCv3, chainConfig.compoundV3?.cWETHv3].filter((a): a is Address => !!a && a !== ZERO),
    morpho_blue: chainConfig.morpho?.morphoBlue,
    uniswap_v3_routers: [chainConfig.uniswapV3?.swapRouter02, chainConfig.uniswapV3?.universalRouter].filter((a): a is Address => !!a),
    aerodrome_router: chainConfig.aerodrome?.router,
  };
  const blockHistoryScanner = new BlockHistoryScanner({ client, registry: senderRegistry, targets: intelTargets, cooccurrence, builderAttribution, logger });
  blockHistoryScanner.start();
  // PnL/calibração/falhas.
  const pnlTracker = new PnlTracker({ dailyLossLimitUsd: 1000, logFilePath: resolve('logs', 'mis-pnl.jsonl'), logger, autoKillEnabled: false });
  const failureTracker = new FailureTracker({ maxConsecutiveFailures: 5, cooldownDurationMs: 60_000, logger });
  const pnlAggregator = new PnlAggregator({ logger });
  const driftTracker = new CalibrationDriftTracker({ logger });
  const pnlReconciler = new PnlReconciler({
    baseDir: resolve('logs', 'pnl-reconciliations'),
    logger,
    onReconcile: (recon) => {
      pnlAggregator.observe(recon);
      driftTracker.observe({
        timestamp: recon.timestamp, protocol: recon.protocol, pair: recon.context.opportunity_id,
        venue: recon.context.venue, hour_utc: new Date(recon.timestamp).getUTCHours(),
        drift_bps: recon.deltas.profit_delta_bps, realized_profit_usd: recon.realized.profit_usd,
      });
    },
  });
  const failureCollector = new FailureCollector({ baseDir: resolve('logs', 'failures'), logger });
  // Post-mortem: alvo = routers DEX (a corrida do arb é por quem inclui primeiro).
  const competitorResolver = new CompetitorResolver({ client, senderRegistry, targets: intelTargets.uniswap_v3_routers.concat(intelTargets.aerodrome_router ? [intelTargets.aerodrome_router] : []), logger });
  const blockPositionTracker = new BlockPositionTracker({ client, logger });
  logger.info('🧠 Camada de inteligência do Motor 2 pronta (competidores + PnL + calibração + post-mortem)');

  // ─── Observabilidade (OIE Etapa D): bridge ledger → Prometheus + /metrics pro Grafana ───
  const metricRegistry = new MetricRegistry({ logger });
  registerStandardMetrics(metricRegistry);
  const metricsExporter = new DimensionMetricsExporter({
    registry: metricRegistry,
    store,
    chain: chainConfig.name,
    windowMs: env.METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    logger,
  });
  metricsExporter.start();
  const healthServer = env.HEALTH_SERVER_ENABLED
    ? startHealthServer({
        serviceName: 'mis-scanner',
        port: env.HEALTH_SERVER_PORT,
        host: env.HEALTH_SERVER_HOST,
        version: 'dryrun',
        readinessProvider: () => ({ status: 'ok', checks: {}, dispatchesPaused: false, pausedReasons: [] }),
        metricsProvider: () => metricRegistry.render(),
        logger,
      })
    : undefined;

  // Recarrega histórico acumulado (padrão liga/desliga)
  const prev = loadSnapshot(SNAPSHOT_PATH);
  if (prev) {
    mis.restore(prev);
    logger.info({ samples: mis.stats().totalSamples }, '📂 histórico anterior recarregado');
  }

  // Monta o universo de pares: curados (tese) + derivados on-chain (colaterais lending)
  const curated = curatedPairsToResolved(sel.pairs, chainConfig);
  let allPairs: ResolvedPair[] = curated;

  const deriveTokens = env.MIS_DERIVE_TOKENS;
  if (deriveTokens) {
    logger.info('🧬 derivando tokens dos colaterais Aave/Moonwell/Morpho...');
    const tokens = await deriveProtocolTokens({
      client,
      chainConfig,
      logger,
      opts: {
        includeMorpho: env.MIS_DERIVE_MORPHO,
        maxPairs: env.MIS_MAX_DERIVED_PAIRS,
      },
    });
    const derived = buildDerivedPairs({
      tokens,
      chainConfig,
      opts: { maxPairs: env.MIS_MAX_DERIVED_PAIRS },
    });
    logger.info({ tokens: tokens.length, derivedPairs: derived.length }, `🧬 ${tokens.length} tokens → ${derived.length} pares derivados`);
    // Curados primeiro (prioridade no dedup), depois derivados
    allPairs = dedupPairs([...curated, ...derived]);
  }

  // Resolve pools on-chain de todos os pares (curados + derivados)
  logger.info({ pairs: allPairs.length }, '🔍 resolvendo pools on-chain...');
  const groups = await resolvePoolGroups({ client, chainConfig, pairs: allPairs, logger });
  for (const g of groups) mis.registerGroup(g);

  if (mis.groupCount() === 0) {
    logger.fatal('Nenhum grupo resolvido — verifique RPC/factory. Abortando.');
    process.exit(1);
  }
  logger.info({ groups: mis.groupCount() }, `✅ MIS pronto — varrendo ${mis.groupCount()} grupos a cada ${SCAN_INTERVAL_MS}ms`);

  // Lookup grupo por label (pro estimador de flash usar tokens/pools reais)
  const groupByLabel = new Map(groups.map((g) => [g.label, g]));
  // Só estima flash em divergência forte o suficiente pra valer o RPC (default = minDiv)
  const flashMinBps = env.MIS_FLASH_MIN_BPS;
  // Budget de slippage do gate de profundidade: round-trip < (1−budget) = pool raso
  const maxSlippageBps = env.MIS_MAX_SLIPPAGE_BPS;

  // ─── Execução de ARB (Motor 2) — opt-in (ARB_EXECUTION_ENABLED) ───
  // Sem lista fixa: o ranking de persistência diz QUAIS pares têm edge; aqui re-cotamos
  // FRESCO e disparamos nos melhores. Atomic-only (flashloan): falha = só gás.
  let arbExec: { deps: Omit<ArbDispatchDeps, 'mode'> & { mode: ArbDispatchDeps['mode'] }; topN: number; notionalUsd: number } | null = null;
  if (env.ARB_EXECUTION_ENABLED) {
    const mode = env.ARB_MODE;
    let wallet: ReturnType<typeof createWalletClient> | undefined;
    let account: Address | undefined;
    if (mode !== 'dryrun') {
      if (!env.EXECUTOR_PRIVATE_KEY) {
        logger.fatal('ARB_MODE != dryrun exige EXECUTOR_PRIVATE_KEY (chave EXCLUSIVA) — abortando');
        process.exit(1);
      }
      const acct = privateKeyToAccount(env.EXECUTOR_PRIVATE_KEY as `0x${string}`);
      account = acct.address;
      wallet = createWalletClient({ account: acct, chain: sel.viem, transport: http(sel.rpc) });
    }
    const profitReceiver = (env.ARB_PROFIT_RECEIVER ?? account ?? '0x0000000000000000000000000000000000000000') as Address;
    const gasOracle = new GasOracle({ priorityFeeGwei: env.GAS_PRIORITY_FEE_GWEI, maxFeeMultiplier: env.GAS_MAX_FEE_MULTIPLIER, logger });
    const maxTradeWei = parseUnits(env.MAX_TRADE_ETH.toString(), 18);
    arbExec = {
      topN: env.ARB_TOP_N,
      notionalUsd: env.ARB_NOTIONAL_USD,
      deps: {
        mode, client, wallet, account,
        executorAddress: env.ARB_EXECUTOR_ADDRESS as Address | undefined,
        chainConfig, gasOracle, profitReceiver,
        ethUsdPrice: env.ETH_USD_PRICE_ESTIMATE, logger,
        minProfitUsd: env.MIN_ARB_PROFIT_USD, maxSlippageBps, maxTradeWei,
        estimatedGasUsd: env.GAS_COST_USD_ESTIMATE,
        // Inteligência (Parte B): reconciliação, falhas, post-mortem, eventos.
        pnlTracker, failureTracker, pnlReconciler, failureCollector, eventBus,
        competitorResolver, blockPositionTracker,
      },
    };
    logger.info({ mode, executor: env.ARB_EXECUTOR_ADDRESS ?? '(ausente)', topN: env.ARB_TOP_N }, `⚙️ Execução de ARB LIGADA (mode=${mode})`);
  } else {
    logger.info('⚙️ Execução de ARB desligada (ARB_EXECUTION_ENABLED=false) — só observação');
  }

  // ─── Sync de métricas de inteligência (Parte B) — competidores + market-bribe + drift ───
  let lastBlocks = 0;
  const intelMetricsInterval = setInterval(() => {
    try {
      const ch = chainConfig.name;
      const ss = blockHistoryScanner.getStats();
      metricRegistry.set('zeus_competitor_profiles_total', ss.unique_senders, { chain: ch });
      const bd = ss.blocks_processed - lastBlocks;
      if (bd > 0) metricRegistry.inc('zeus_scanner_blocks_processed_total', { chain: ch }, bd);
      lastBlocks = ss.blocks_processed;
      const mkt = senderRegistry.marketBribeStats();
      metricRegistry.set('zeus_market_bribe_priority_fee_gwei', mkt.p50Gwei, { chain: ch, percentile: 'p50' });
      metricRegistry.set('zeus_market_bribe_priority_fee_gwei', mkt.p75Gwei, { chain: ch, percentile: 'p75' });
      metricRegistry.set('zeus_market_bribe_competitors_active', mkt.competitorsActive, { chain: ch });
      const dr = driftTracker.stats();
      metricRegistry.set('zeus_drift_sustained_alerts', dr.sustained_alerts_count, { chain: ch });
      metricRegistry.set('zeus_pnl_avg_drift_bps_all', dr.avg_drift_bps_all, { chain: ch });
    } catch (err) {
      logger.debug?.({ err: err instanceof Error ? err.message : err }, 'metrics sync MIS: erro (drop)');
    }
  }, 5_000);
  intelMetricsInterval.unref();

  // ─── Auto-calibração (Etapa C) — recalcula o gate de EV do arb a partir do ledger ───
  const runAdaptive = async () => {
    try {
      const adaptive = await computeAdaptiveThresholds({
        store, chain: chainConfig.name,
        windowMs: env.ADAPTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      });
      if (env.ADAPTIVE_THRESHOLDS_ENABLED && arbExec) {
        arbExec.deps.minProfitUsd = adaptive.MIN_OPPORTUNITY_EV_USD; // mesma ref → afeta o gate
      }
      logger.info({ applied: env.ADAPTIVE_THRESHOLDS_ENABLED && !!arbExec, minEv: adaptive.MIN_OPPORTUNITY_EV_USD, top: adaptive.topProtocol }, `📈 adaptive (MIS): MIN_EV=$${adaptive.MIN_OPPORTUNITY_EV_USD}`);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'adaptive recalc MIS falhou (skip)');
    }
  };
  void runAdaptive();
  const adaptiveTimer = setInterval(() => void runAdaptive(), env.ADAPTIVE_RECALC_INTERVAL_SEC * 1000);
  adaptiveTimer.unref();

  // Graceful shutdown: salva snapshot + drena o ledger DuckDB ao sair (Ctrl+C)
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    metricsExporter.stop();
    healthServer?.close();
    blockHistoryScanner.stop();        // salva snapshot do registry de competidores
    saveSnapshot(SNAPSHOT_PATH, mis.snapshot());
    await eventIngester.stop();        // flush do ledger
    await store.shutdown();
    logger.info({ samples: mis.stats().totalSamples }, '💾 snapshot + ledger salvos — até a próxima varredura');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  let scanCount = 0;
  const tick = async () => {
    if (stopping) return;
    try {
      const obs = await mis.scanAllBatched(client);
      scanCount++;
      const active = obs.filter((o) => o.maxDivergenceBps >= minDivergenceBps);
      if (active.length > 0) {
        logger.info(
          { divergences: active.map((o) => `${o.groupLabel}=${o.maxDivergenceBps}bps`) },
          `📡 scan #${scanCount}: ${active.length} grupos com divergência ativa`,
        );

        // Enriquece com dados do flash (quoter on-chain) só pras divergências fortes
        const strong = active.filter((o) => o.maxDivergenceBps >= flashMinBps && groupByLabel.has(o.groupLabel));
        const ethUsd = strong.length > 0 ? await fetchEthUsd(client, chainConfig) : 0; // cotado 1x/tick
        // Candidatos viáveis deste scan (pra execução top-N por lucro, se ligada).
        const execCandidates: { group: PoolGroup; netProfitUsd: number }[] = [];
        for (const o of strong) {
          const group = groupByLabel.get(o.groupLabel)!;
          try {
            // Acha o TAMANHO ÓTIMO do empréstimo (pico de lucro antes do slippage matar)
            const opt = await optimizeFlashLoan({
              client, chainConfig, group, observation: o,
              opts: { ethUsd, maxSlippageBps },
            });
            // Sem tamanho viável (mesmo o menor não lucra / pool raso) → fora do ranking
            const viable = opt.best !== null && opt.maxViableLoanUsd > 0;
            mis.markThin(o.groupLabel, !viable);

            if (!viable) {
              const rt = opt.curve[0]?.roundTripRatio ?? 0;
              logger.info(
                { par: o.groupLabel, divBps: o.maxDivergenceBps, melhorRoundTrip: `${(rt * 100).toFixed(1)}%`, curva: opt.curve },
                `🕳️ ${o.groupLabel} INVIÁVEL: nenhum tamanho de empréstimo fecha com lucro — fora do ranking`,
              );
              continue;
            }

            const b = opt.best!;

            // OIE — grava a ineficiência viável no ledger (DuckDB) pro ranking de pares.
            store.ingest(
              buildObservationEvent({
                chain: chainConfig.name,
                category: 'mis_observed',
                protocol: 'mis',
                pair: b.pair,
                amount_usd: b.loanUsd,
                profit_usd: b.netProfitUsd,
                gas_usd: b.gasCostUsd,
                slippage_bps: Math.round((1 - b.roundTripRatio) * 10_000),
                payload: {
                  divergenceBps: b.divergenceBps,
                  roundTripRatio: b.roundTripRatio,
                  maxViableLoanUsd: opt.maxViableLoanUsd,
                  cheapPool: b.cheapPool,
                  expensivePool: b.expensivePool,
                  profitPct: b.profitPct,
                },
              }),
            );

            logger.info(
              {
                par: b.pair,
                hora: b.isoTime,
                rota: `${b.cheapPool} → ${b.expensivePool}`,
                divBps: b.divergenceBps,
                emprestimoOtimo: `$${b.loanUsd} (${b.loanTokenB})`,
                tetoViavel: `$${opt.maxViableLoanUsd}`,
                devolucaoAave: `$${b.repayUsd.toFixed(2)} (${b.repayTokenB})`,
                gasCusto: `$${b.gasCostUsd}`,
                lucroLiquido: `$${b.netProfitUsd}`,
                lucroPct: `${b.profitPct}%`,
                roundTrip: `${(b.roundTripRatio * 100).toFixed(1)}%`,
                curva: opt.curve.map((c) => `$${c.loanUsd}→$${c.netProfitUsd}`),
              },
              `💰 ${b.pair}: ótimo $${b.loanUsd} → líquido $${b.netProfitUsd} (${b.profitPct}%) · teto viável $${opt.maxViableLoanUsd}`,
            );
            execCandidates.push({ group, netProfitUsd: b.netProfitUsd });
          } catch (err) {
            logger.debug?.({ par: o.groupLabel, err: err instanceof Error ? err.message : err }, 'otimização de flash falhou');
          }
        }

        // ─── EXECUÇÃO (opt-in): re-cota FRESCO os top-N por lucro e dispara ───
        if (arbExec && execCandidates.length > 0) {
          const top = execCandidates.sort((a, b2) => b2.netProfitUsd - a.netProfitUsd).slice(0, arbExec.topN);
          for (const cand of top) {
            try {
              const estUsdA = await fetchTokenUsd(client, chainConfig, cand.group.tokenA, cand.group.decimalsA);
              const estUsdB = await fetchTokenUsd(client, chainConfig, cand.group.tokenB, cand.group.decimalsB);
              const opp = await findFreshArb({
                client, group: cand.group, notionalUsd: arbExec.notionalUsd,
                estimatedUsdValueA: estUsdA, estimatedUsdValueB: estUsdB,
              });
              if (!opp) {
                logger.debug?.({ par: cand.group.label }, 'arb: re-cotação não confirmou lucro (spread fechou)');
                continue;
              }
              const res = await dispatchArb(opp, arbExec.deps);
              logger.info({ par: cand.group.label, status: res.status, txHash: res.txHash, net: res.netProfitUsd, flashSource: res.flashSource }, `⚡ arb ${cand.group.label}: ${res.status}`);
            } catch (err) {
              logger.warn({ par: cand.group.label, err: err instanceof Error ? err.message : err }, 'execução de arb falhou (continua)');
            }
          }
        }
      }
      saveSnapshot(SNAPSHOT_PATH, mis.snapshot());

      if (scanCount % RANKING_EVERY === 0) {
        const ranking = mis.ranking().slice(0, 10);
        logger.info(
          {
            ranking: ranking.map((r) => ({ par: r.groupLabel, score: r.score, persist: `${(r.persistenceRatio * 100).toFixed(0)}%`, avgBps: r.avgDivergenceBps, n: r.samples })),
            rasosExcluidos: mis.thinCount(),
          },
          `🏆 Ranking de ineficiência persistente (top ${ranking.length}, ${mis.thinCount()} rasos fora)`,
        );
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'scan falhou (continua)');
    }
  };

  await tick();
  // SEM unref: o scanner deve varrer continuamente até SIGINT (padrão "deixa varrendo").
  setInterval(() => void tick(), SCAN_INTERVAL_MS);
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, 'MIS scanner crashou');
  process.exit(1);
});
