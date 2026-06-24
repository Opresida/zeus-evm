/**
 * ZEUS EVM — Backrun engine entrypoint.
 *
 * Motor #2 descorrelacionado (vol-driven). Reage a swaps whale na mempool
 * pra capturar dislocation cross-DEX via flashloan atômico.
 *
 * Bootstrap:
 *   1. Carrega config + chain context
 *   2. Cria EventBus + trackers (PnL/Failure/GasOracle)
 *   3. Plug sinks (Discord webhook opcional, generic webhook opcional)
 *   4. Sobe whaleSwapSubscription (placeholder até Alchemy Growth+)
 *   5. Subscribe processWhaleSwap pra eventos 'whale.swap_detected'
 *
 * Em DRY_RUN: subscriber roda mas dispatcher só loga (não submete tx).
 */

import {
  EventBus,
  PnlTracker,
  FailureTracker,
  GasOracle,
  TimeseriesStore,
  EventIngester,
  startHealthServer,
  FinalityTracker,
  BlockStalenessCheck,
  ProcessCheck,
  AutoPauseManager,
  Tracer,
  PnlReconciler,
  PnlAggregator,
  CalibrationDriftTracker,
  FailureCollector,
  CompetitorResolver,
  BlockPositionTracker,
  MetricRegistry,
  registerStandardMetrics,
  SenderRegistry,
  BlockHistoryScanner,
  CooccurrenceAnalyzer,
  BuilderAttributionTracker,
  ingestSnapshot,
  subscribeWhaleSwaps,
  createDiscordSink,
  createGenericWebhookSink,
  resolveIntelligenceDbPath,
  computeAdaptiveThresholds,
  type WhaleSwapDetectedEvent,
  type ReadinessReport,
  type ComponentCheck,
} from '@zeus-evm/execution-utils';
import type { Severity } from '@zeus-evm/execution-utils';
import type { Address, Hex } from 'viem';
import { resolve as resolvePath } from 'node:path';
import { writeFileSync } from 'node:fs';

import { loadConfig } from './config';
import { buildChainContext } from './chainContext';
import { logger } from './logger';
import { processWhaleSwap, type BackrunPipelineDeps } from './pipeline';
import { BribeCalculator, GasWarDetector, CompetitionTracker } from './bribe';
import { RelayRouter } from './bundling';

async function main() {
  const env = loadConfig();
  const chainCtx = buildChainContext(env);

  logger.info(
    {
      chain: chainCtx.chainName,
      chainId: chainCtx.chainId,
      mode: env.BACKRUN_MODE,
      minSwapUsd: env.BACKRUN_MIN_SWAP_USD,
      minProfitUsd: env.MIN_BACKRUN_PROFIT_USD,
    },
    `🚀 Backrun engine boot — mode=${env.BACKRUN_MODE} chain=${chainCtx.chainName}`,
  );

  // EventBus + trackers (mesmos do liquidator, instâncias separadas)
  const eventBus = new EventBus();

  // Historical Intelligence — Item 15 I1+I2 (DuckDB + EventIngester)
  // Coleta automática de eventos pra dataset histórico do ZEUS.
  // Mesmo .duckdb file que liquidator pra dataset unificado cross-engine.
  const intelligenceStore = new TimeseriesStore({
    dbPath: resolveIntelligenceDbPath('intelligence-backrun.duckdb'),
    logger,
  });
  await intelligenceStore.init();
  const eventIngester = new EventIngester({
    store: intelligenceStore,
    eventBus,
    logger,
    defaultChain: chainCtx.chainName,
  });
  eventIngester.start();

  // ── Prometheus MetricRegistry (Fase 7) — antes o motor 3 NÃO expunha /metrics ──
  const metricRegistry = new MetricRegistry({ logger });
  registerStandardMetrics(metricRegistry);
  // Counter de falhas por categoria — incrementa por evento (igual ao liquidator).
  eventBus.subscribe((event) => {
    if (event.type === 'failure.recorded') {
      metricRegistry.inc('zeus_failures_total', {
        chain: event.chain,
        category: event.failureCategory,
        protocol: event.protocol,
      });
    }
  });
  logger.info({ definitions: metricRegistry.stats().definitions }, '📊 Prometheus registry pronto (backrun)');

  const pnlTracker = new PnlTracker({
    dailyLossLimitUsd: env.DAILY_LOSS_LIMIT_USD,
    logFilePath: env.PNL_LOG_FILE,
    logger,
    autoKillEnabled: false, // backrun não trigga on-chain kill (escopo do liquidator)
  });
  const failureTracker = new FailureTracker({
    maxConsecutiveFailures: env.MAX_CONSECUTIVE_FAILURES,
    cooldownDurationMs: env.COOLDOWN_DURATION_SEC * 1000,
    logger,
  });
  const gasOracle = new GasOracle({
    priorityFeeGwei: env.GAS_PRIORITY_FEE_GWEI,
    maxFeeMultiplier: env.GAS_MAX_FEE_MULTIPLIER,
    logger,
  });

  // ── Análise de PnL (Fase D1) — espelha o liquidator: agregação + alarme de drift ──
  const pnlAggregator = new PnlAggregator({ logger });
  const driftTracker = new CalibrationDriftTracker({ logger });

  // ── PnL Reconciler (Item 10) ──
  const pnlReconciler = new PnlReconciler({
    baseDir: resolvePath('logs', 'pnl-reconciliations'),
    logger,
    onReconcile: (recon) => {
      pnlAggregator.observe(recon);
      driftTracker.observe({
        timestamp: recon.timestamp,
        protocol: recon.protocol,
        pair: recon.context.opportunity_id,
        venue: recon.context.venue,
        hour_utc: new Date(recon.timestamp).getUTCHours(),
        drift_bps: recon.deltas.profit_delta_bps,
        realized_profit_usd: recon.realized.profit_usd,
      });
    },
  });

  // ── FailureCollector (Item 4) ──
  const failureCollector = new FailureCollector({
    baseDir: resolvePath('logs', 'failures'),
    logger,
  });

  // ── SenderRegistry + scanner + analisadores (Fase 7) ──
  // Antes só o liquidator tinha dados de competidor. Agora o motor 3 também coleta — isso faz
  // o market-bribe (Fase 1) valer aqui, onde o bribe REALMENTE importa (corrida de inclusão).
  const senderRegistry = new SenderRegistry({ baseDir: resolvePath('logs', 'competitors'), logger });
  const cooccurrence = new CooccurrenceAnalyzer();
  const builderAttribution = new BuilderAttributionTracker({
    ourAccount: chainCtx.account ?? '0x0000000000000000000000000000000000000000',
    logger,
  });
  const scannerTargets = {
    aave_v3_pool: chainCtx.chainConfig.aave?.pool,
    compound_comets: [
      chainCtx.chainConfig.compoundV3?.cUSDCv3,
      chainCtx.chainConfig.compoundV3?.cWETHv3,
    ].filter((a): a is Address => !!a && a !== '0x0000000000000000000000000000000000000000'),
    morpho_blue: chainCtx.chainConfig.morpho?.morphoBlue,
    uniswap_v3_routers: [
      chainCtx.chainConfig.uniswapV3?.swapRouter02,
      chainCtx.chainConfig.uniswapV3?.universalRouter,
    ].filter((a): a is Address => !!a),
    aerodrome_router: chainCtx.chainConfig.aerodrome?.router,
  };
  const blockHistoryScanner = new BlockHistoryScanner({
    client: chainCtx.client,
    registry: senderRegistry,
    targets: scannerTargets,
    cooccurrence,
    builderAttribution,
    logger,
  });
  blockHistoryScanner.start();

  // ── Post-mortem de falhas (Fase D2) — espelha o liquidator: quem nos ganhou + posição no bloco ──
  // No backrun, os "targets" são os routers DEX (a corrida é por quem backrunna primeiro).
  const competitorTargets = [
    scannerTargets.aerodrome_router,
    ...(scannerTargets.uniswap_v3_routers ?? []),
  ].filter((a): a is Address => !!a);
  const competitorResolver = new CompetitorResolver({
    client: chainCtx.client,
    senderRegistry,
    targets: competitorTargets,
    logger,
  });
  const blockPositionTracker = new BlockPositionTracker({ client: chainCtx.client, logger });

  // ── Tracer (Item 16B OB1) ──
  const tracer = new Tracer({ serviceName: 'backrun-engine', logger });

  // ── AutoPauseManager (Item 12 H10) — agrega sinais de health ──
  const autoPauseManager = new AutoPauseManager({ logger });

  // ── FinalityTracker (Item 9 R1) ──
  const finalityTracker = new FinalityTracker({ client: chainCtx.client, logger });
  finalityTracker.onReorg((ev) => {
    if (ev.depth >= 3 || finalityTracker.isCircuitBreakerActive()) {
      autoPauseManager.setReason(
        'reorg',
        'critical',
        `reorg depth=${ev.depth} ancestor=${ev.commonAncestorBlock}`,
      );
      setTimeout(() => autoPauseManager.clearReason('reorg'), 5 * 60 * 1000).unref();
    }
  });
  finalityTracker.start();

  // ── BlockStalenessCheck (Item 12 H3) ──
  const blockStalenessCheck = new BlockStalenessCheck({ client: chainCtx.client, logger });
  blockStalenessCheck.onStatusChange((r) => {
    if (r.status === 'critical') {
      autoPauseManager.setReason('block_staleness', 'critical', `${r.age_seconds.toFixed(0)}s sem bloco`);
    } else {
      autoPauseManager.clearReason('block_staleness');
    }
  });
  blockStalenessCheck.start();

  // ── ProcessCheck (Item 12 H7) ──
  const processCheck = new ProcessCheck({ logger });
  processCheck.onStatusChange((p) => {
    if (p.status === 'critical') {
      autoPauseManager.setReason(
        'process',
        'critical',
        `mem ${p.memory_mb.rss.toFixed(0)}MB lag ${p.event_loop_lag_ms.toFixed(0)}ms`,
      );
    } else {
      autoPauseManager.clearReason('process');
    }
  });
  processCheck.start();

  // Health server — Item 12 H8+H11 (/healthz + /readyz)
  if (env.HEALTH_SERVER_ENABLED) {
    startHealthServer({
      serviceName: 'backrun-engine',
      port: env.HEALTH_SERVER_PORT,
      host: env.HEALTH_SERVER_HOST,
      version: 'v8.2',
      logger,
      readinessProvider: () => buildBackrunReadinessReport({
        pnlTracker,
        failureTracker,
        intelligenceStore,
        eventIngester,
        autoPauseManager,
        finalityTracker,
        blockStalenessCheck,
        processCheck,
        mode: env.BACKRUN_MODE,
      }),
      // Fase 7 — expõe /metrics (antes o motor 3 era invisível no Prometheus).
      metricsProvider: () => metricRegistry.render(),
    });
  }

  // Sinks (alerting) — só ativa se URL setada
  if (env.DISCORD_WEBHOOK_URL) {
    const severities = env.DISCORD_SEVERITIES.split(',').map((s) => s.trim()) as Severity[];
    eventBus.subscribe(
      createDiscordSink({
        webhookUrl: env.DISCORD_WEBHOOK_URL,
        username: 'ZEUS Backrun',
        severities,
        logger,
      }),
    );
    logger.info({ severities }, '🔔 Discord sink registrado');
  }
  if (env.GENERIC_WEBHOOK_URL) {
    const severities = env.GENERIC_SEVERITIES.split(',').map((s) => s.trim()) as Severity[];
    eventBus.subscribe(
      createGenericWebhookSink({
        url: env.GENERIC_WEBHOOK_URL,
        severities,
        secret: env.GENERIC_WEBHOOK_SECRET,
        logger,
      }),
    );
    logger.info({ severities, auth: env.GENERIC_WEBHOOK_SECRET ? 'x-zeus-secret' : 'none' }, '🔔 Generic webhook sink registrado');
  }

  // Bribe machinery (v7)
  const bribeCalculator = new BribeCalculator({
    minProfitUsd: env.BRIBE_MIN_PROFIT_USD,
    hardCapBps: env.BRIBE_HARD_CAP_BPS,
    defaultSwapFeeTier: env.BRIBE_SWAP_FEE_TIER,
    defaultSwapSlippageBps: env.BRIBE_SWAP_SLIPPAGE_BPS,
    ethUsdPrice: env.ETH_USD_PRICE_ESTIMATE,
    logger,
  });
  const gasWarDetector = new GasWarDetector({ logger });
  const competitionTracker = new CompetitionTracker({ logger });

  // Bundle relay router — só ativa se ao menos 1 URL configurada
  let relayRouter: RelayRouter | undefined;
  const hasAnyRelay =
    env.FLASHBOTS_RELAY_URL || env.ATLAS_RELAY_URL || env.BLOCKNATIVE_RELAY_URL;
  if (hasAnyRelay && env.BACKRUN_MODE !== 'dryrun') {
    relayRouter = new RelayRouter({
      config: {
        flashbotsUrl: env.FLASHBOTS_RELAY_URL,
        atlasUrl: env.ATLAS_RELAY_URL,
        blocknativeUrl: env.BLOCKNATIVE_RELAY_URL,
        flashbotsAuthKey: env.FLASHBOTS_AUTH_KEY as Hex | undefined,
        identityAddress: chainCtx.account,
        timeoutMs: env.RELAY_TIMEOUT_MS,
      },
      logger,
    });
    logger.info(
      { relays: relayRouter.registeredRelays() },
      `📦 Bundle relay router registrado (${relayRouter.registeredRelays().length} relay(s))`,
    );
  } else if (env.BACKRUN_MODE !== 'dryrun') {
    logger.warn(
      'Nenhuma URL de bundle relay configurada — fallback mempool público. Configure FLASHBOTS_RELAY_URL etc pra ativar bundles privados.',
    );
  }

  // Deps comuns pra pipeline
  const deps: BackrunPipelineDeps = {
    env,
    chainCtx,
    mode: env.BACKRUN_MODE,
    eventBus,
    pnlTracker,
    failureTracker,
    gasOracle,
    bribeCalculator,
    gasWarDetector,
    competitionTracker,
    relayRouter,
    pnlReconciler,
    failureCollector,
    metricRegistry,
    competitorResolver,
    blockPositionTracker,
    botSender: chainCtx.account,
  };

  // Poll baseFee a cada 5s pra alimentar gasWarDetector
  setInterval(() => {
    void gasWarDetector.pollBaseFee(chainCtx.client);
  }, 5_000);

  // ── Sync de métricas Prometheus (Fase 7) — a cada 5s ──
  let lastBlocksProcessed = 0;
  let hbTick = 0; // throttle do heartbeat (~30s)
  const chainName = chainCtx.chainName;
  const metricsSyncInterval = setInterval(() => {
    try {
      const proc = processCheck.getStatus();
      metricRegistry.set('zeus_uptime_seconds', proc.uptime_sec, { service: 'backrun-engine' });
      metricRegistry.set('zeus_process_memory_rss_mb', proc.memory_mb.rss, { service: 'backrun-engine' });
      metricRegistry.set('zeus_event_loop_lag_ms', proc.event_loop_lag_ms, { service: 'backrun-engine' });
      const stale = blockStalenessCheck.getStatus();
      metricRegistry.set('zeus_block_staleness_seconds', stale.age_seconds, { chain: chainName });
      // PnL (realizado + esperado + drift + gás) a partir da reconciliação.
      metricRegistry.set('zeus_pnl_realized_usd_total', pnlTracker.stats().netPnlUsd, { chain: chainName, protocol: 'backrun' });
      const reconStats = pnlReconciler.stats();
      metricRegistry.set('zeus_pnl_expected_usd_total', reconStats.expectedTotalUsd, { chain: chainName, protocol: 'backrun' });
      metricRegistry.set('zeus_pnl_drift_bps', reconStats.avgDriftBps, { chain: chainName, protocol: 'backrun' });
      metricRegistry.set('zeus_gas_usd_paid_total', pnlReconciler.cumulativeGasUsdPaid(), { chain: chainName });
      // Competidores + scanner (delta no counter de blocos).
      const scannerStats = blockHistoryScanner.getStats();
      metricRegistry.set('zeus_competitor_profiles_total', scannerStats.unique_senders, { chain: chainName });
      const blocksDelta = scannerStats.blocks_processed - lastBlocksProcessed;
      if (blocksDelta > 0) metricRegistry.inc('zeus_scanner_blocks_processed_total', { chain: chainName }, blocksDelta);
      lastBlocksProcessed = scannerStats.blocks_processed;
      // Market-bribe (lance de mercado) — agora também no motor 3.
      const mkt = senderRegistry.marketBribeStats();
      metricRegistry.set('zeus_market_bribe_priority_fee_gwei', mkt.p50Gwei, { chain: chainName, percentile: 'p50' });
      metricRegistry.set('zeus_market_bribe_priority_fee_gwei', mkt.p75Gwei, { chain: chainName, percentile: 'p75' });
      metricRegistry.set('zeus_market_bribe_priority_fee_gwei', mkt.p95Gwei, { chain: chainName, percentile: 'p95' });
      metricRegistry.set('zeus_market_bribe_competitors_active', mkt.competitorsActive, { chain: chainName });
      // Calibração (Fase D1) — drift sustentado + drift médio.
      const drift = driftTracker.stats();
      metricRegistry.set('zeus_drift_sustained_alerts', drift.sustained_alerts_count, { chain: chainName });
      metricRegistry.set('zeus_pnl_avg_drift_bps_all', drift.avg_drift_bps_all, { chain: chainName });

      // Heartbeat ~30s pro painel. Motor 3 está bloqueado em prod (mempool placeholder) → autoPaused=true.
      if (hbTick++ % 6 === 0) {
        eventBus.emit({
          type: 'zeus.heartbeat', timestamp: new Date().toISOString(), chain: chainName, mode: env.BACKRUN_MODE as 'dryrun' | 'testnet' | 'mainnet',
          severity: 'info', service: 'backrun-engine', uptimeSec: Math.floor(proc.uptime_sec),
          autoPaused: true, motorStats: [{ tag: 'motor3', ops: 0, netPnl24hUsd: pnlTracker.stats().netPnlUsd }],
        });
      }
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, 'metrics sync backrun: erro (drop)');
    }
  }, 5_000);
  metricsSyncInterval.unref();

  // ── Alarme de drift (Fase D1) — WARN com sugestão quando há drift sustentado ──
  const driftAlertInterval = setInterval(() => {
    for (const alert of driftTracker.topAlerts(5)) {
      logger.warn(
        { dimension: alert.dimension, key: alert.key, avgDriftBps: alert.avg_drift_bps, samples: alert.samples },
        `⚠️ drift sustentado (backrun): ${alert.suggested_action}`,
      );
    }
  }, 10 * 60 * 1000);
  driftAlertInterval.unref();

  // ── Snapshot da inteligência órfã → ledger (Fase 7, espelha o liquidator) ──
  const intelSnapshotInterval = setInterval(() => {
    const mkt = senderRegistry.marketBribeStats();
    if (mkt.competitorsActive > 0) {
      ingestSnapshot(intelligenceStore, {
        chain: chainName, category: 'market_bribe', protocol: 'bribe', pair: 'MARKET',
        amount_usd: mkt.p75Gwei, payload: { ...mkt },
      }, logger);
    }
    const compStats = senderRegistry.stats();
    if (compStats.total_profiles > 0) {
      ingestSnapshot(intelligenceStore, {
        chain: chainName, category: 'competitor', protocol: 'aggregate',
        amount_usd: compStats.total_profiles, payload: { total: compStats.total_profiles, byCategory: compStats.by_category },
      }, logger);
    }
    const coSnap = cooccurrence.snapshot();
    metricRegistry.set('zeus_sybil_clusters_total', coSnap.clusters.length, { chain: chainName });
    metricRegistry.set('zeus_sybil_strong_links', coSnap.stats.strong_links, { chain: chainName });
    metricRegistry.set('zeus_builders_tracked', builderAttribution.size(), { chain: chainName });
    try {
      writeFileSync(resolvePath('logs', 'competitors', 'cooccurrence-backrun.json'), JSON.stringify(coSnap, null, 2));
      writeFileSync(resolvePath('logs', 'competitors', 'builders-backrun.json'), JSON.stringify(builderAttribution.snapshot(), null, 2));
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, 'snapshot sybil/builder backrun: erro (segue)');
    }
  }, 5 * 60 * 1000);
  intelSnapshotInterval.unref();

  // Subscribe ao bus pra processar WhaleSwapDetectedEvent
  eventBus.subscribe(async (event) => {
    if (event.type !== 'whale.swap_detected') return;
    const whale = whaleFromEvent(event);
    await processWhaleSwap(whale, deps);
  });

  // Mempool subscription — atualmente placeholder até Alchemy Growth+
  subscribeWhaleSwaps({
    wsUrl: env.ALCHEMY_MEMPOOL_WSS_URL,
    minSwapUsd: env.BACKRUN_MIN_SWAP_USD,
    routers: chainCtx.knownRouters,
    eventBus,
    chain: chainCtx.chainName,
    mode: env.BACKRUN_MODE,
    logger,
  });

  logger.info(
    {
      hasMempool: Boolean(env.ALCHEMY_MEMPOOL_WSS_URL),
      executor: chainCtx.executorAddress ?? '(não configurado)',
      bot: chainCtx.account ?? '(dryrun)',
    },
    '⚡ Backrun engine ONLINE — aguardando whale swaps',
  );

  // ─── OIE Etapa C: thresholds adaptativos (recalc periódico) ───
  const adaptiveEnabled = (process.env.ADAPTIVE_THRESHOLDS_ENABLED ?? 'false') === 'true';
  const adaptiveIntervalMs = Number(process.env.ADAPTIVE_RECALC_INTERVAL_SEC ?? 600) * 1000;
  const adaptiveWindowMs = Number(process.env.ADAPTIVE_WINDOW_DAYS ?? 7) * 24 * 60 * 60 * 1000;
  const runAdaptiveRecalc = async () => {
    try {
      const adaptive = await computeAdaptiveThresholds({
        store: intelligenceStore,
        chain: chainCtx.chainName,
        windowMs: adaptiveWindowMs,
      });
      if (adaptiveEnabled) {
        // Injeção opt-in: o gate de backrun lê env.MIN_OPPORTUNITY_EV_USD (mesma ref).
        env.MIN_OPPORTUNITY_EV_USD = adaptive.MIN_OPPORTUNITY_EV_USD;
      }
      logger.info(
        { applied: adaptiveEnabled, ...adaptive },
        `📈 OIE adaptive: MIN_EV=$${adaptive.MIN_OPPORTUNITY_EV_USD} top=${adaptive.topProtocol ?? '-'} ${adaptiveEnabled ? '(APLICADO)' : '(só log)'}`,
      );
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'adaptive recalc falhou (skip)');
    }
  };
  void runAdaptiveRecalc();
  const adaptiveTimer = setInterval(() => void runAdaptiveRecalc(), adaptiveIntervalMs);
  adaptiveTimer.unref();

  // ─── Graceful shutdown (Item 7) ───
  // Drena o ledger (eventIngester.stop() faz o flush) + para timers de background.
  // TODO(live): aguardar tx in-flight confirmar antes do exit quando submeter de verdade.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      clearInterval(adaptiveTimer);
      finalityTracker.stop();
      blockStalenessCheck.stop();
      processCheck.stop();
      blockHistoryScanner.stop();       // salva snapshot do registry
      await eventIngester.stop();       // flush do store
      await intelligenceStore.shutdown();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'erro no shutdown (segue)');
    }
    logger.info('💾 ledger drenado — backrun encerrado');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Mantém processo vivo
  await new Promise(() => {});
}

/**
 * Reconstrói WhaleSwap do evento. Decimais do tokenIn/Out NÃO vêm no evento
 * (são pesados pra propagar) — caller PRECISA preencher antes via lookup.
 *
 * MVP: decimals default 18 + symbol unknown. Quando integrar resolveDecimals
 * no whaleSwapSubscription, esses campos virão preenchidos.
 */
function whaleFromEvent(event: WhaleSwapDetectedEvent) {
  return {
    pendingTxHash: event.pendingTxHash,
    venue: event.venue,
    router: event.router,
    tokenIn: event.tokenIn as Address,
    tokenOut: event.tokenOut as Address,
    amountIn: BigInt(event.amountIn),
    amountInUsd: event.amountInUsd,
    sender: event.sender,
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
    observedAtBlock: 0n,
    detectedAt: Date.now(),
  };
}

/**
 * Constrói snapshot de readiness pro health endpoint `/readyz`.
 */
function buildBackrunReadinessReport(deps: {
  pnlTracker: PnlTracker;
  failureTracker: FailureTracker;
  intelligenceStore: TimeseriesStore;
  eventIngester: EventIngester;
  autoPauseManager: AutoPauseManager;
  finalityTracker: FinalityTracker;
  blockStalenessCheck: BlockStalenessCheck;
  processCheck: ProcessCheck;
  mode: string;
}): ReadinessReport {
  const pnlStats = deps.pnlTracker.stats();
  const failureStats = deps.failureTracker.stats();
  const intelStats = deps.intelligenceStore.stats();
  const ingestStats = deps.eventIngester.getStats();
  const pauseStatus = deps.autoPauseManager.status();
  const finalityStats = deps.finalityTracker.stats();
  const staleness = deps.blockStalenessCheck.getStatus();
  const procHealth = deps.processCheck.getStatus();

  const checks: Record<string, ComponentCheck> = {
    pnl: {
      ok: !pnlStats.killSwitchTriggered,
      netPnlUsd24h: pnlStats.netPnlUsd,
      wins24h: pnlStats.wins,
      losses24h: pnlStats.losses,
    },
    failure: {
      ok: !failureStats.inCooldown,
      reason: failureStats.inCooldown ? `cooldown ${failureStats.cooldownRemainingMs}ms` : undefined,
      consecutiveFailures: failureStats.consecutiveFailures,
    },
    intelligence_store: {
      ok: intelStats.flushErrors < 10,
      reason: intelStats.flushErrors >= 10 ? `${intelStats.flushErrors} flush errors` : undefined,
      totalEvents: intelStats.totalEvents,
      pendingWrites: intelStats.pendingWrites,
    },
    event_ingester: {
      ok: ingestStats.errors < 10,
      eventsIngested: ingestStats.eventsIngested,
      eventsDropped: ingestStats.eventsDropped,
    },
    block_staleness: {
      ok: staleness.status !== 'critical',
      reason: staleness.status,
      ageSec: staleness.age_seconds.toFixed(1),
    },
    process: {
      ok: procHealth.status !== 'critical',
      reason: procHealth.status,
      memoryRssMb: procHealth.memory_mb.rss.toFixed(0),
      eventLoopLagMs: procHealth.event_loop_lag_ms.toFixed(1),
    },
    finality: {
      ok: !finalityStats.circuitBreakerActive,
      reason: finalityStats.circuitBreakerActive ? 'reorg circuit breaker' : undefined,
      reorgsLifetime: finalityStats.reorgsLifetime,
    },
    auto_pause: {
      ok: !pauseStatus.hard_pause,
      reason: pauseStatus.paused ? deps.autoPauseManager.summary() : undefined,
      activeReasons: pauseStatus.reasons.length,
    },
  };

  const anyCritical = pauseStatus.hard_pause || pnlStats.killSwitchTriggered || staleness.status === 'critical' || procHealth.status === 'critical';
  const anyDegraded = Object.values(checks).some((c) => !c.ok);

  return {
    status: anyCritical ? 'critical' : anyDegraded ? 'degraded' : 'ok',
    checks,
    dispatchesPaused: pauseStatus.paused || pnlStats.killSwitchTriggered || failureStats.inCooldown,
    pausedReasons: [
      ...(pnlStats.killSwitchTriggered ? [`kill_switch: ${pnlStats.killSwitchReason ?? 'unknown'}`] : []),
      ...(failureStats.inCooldown ? [`cooldown ${failureStats.cooldownRemainingMs}ms`] : []),
      ...pauseStatus.reasons.map((r) => `${r.source}: ${r.message}`),
      ...(deps.mode === 'dryrun' ? ['dryrun (no dispatches submitted)'] : []),
    ],
  };
}

main().catch((err) => {
  logger.error({ err }, 'Backrun engine crashed at boot');
  process.exit(1);
});
