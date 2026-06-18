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
  FailureCollector,
  subscribeWhaleSwaps,
  createDiscordSink,
  createGenericWebhookSink,
  resolveIntelligenceDbPath,
  type WhaleSwapDetectedEvent,
  type ReadinessReport,
  type ComponentCheck,
} from '@zeus-evm/execution-utils';
import type { Severity } from '@zeus-evm/execution-utils';
import type { Address, Hex } from 'viem';
import { resolve as resolvePath } from 'node:path';

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
    dbPath: resolveIntelligenceDbPath('intelligence.duckdb'),
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

  // ── PnL Reconciler (Item 10) ──
  const pnlReconciler = new PnlReconciler({
    baseDir: resolvePath('logs', 'pnl-reconciliations'),
    logger,
  });

  // ── FailureCollector (Item 4) ──
  const failureCollector = new FailureCollector({
    baseDir: resolvePath('logs', 'failures'),
    logger,
  });

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
        logger,
      }),
    );
    logger.info({ severities }, '🔔 Generic webhook sink registrado');
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
  };

  // Poll baseFee a cada 5s pra alimentar gasWarDetector
  setInterval(() => {
    void gasWarDetector.pollBaseFee(chainCtx.client);
  }, 5_000);

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

  // ─── Graceful shutdown (Item 7) ───
  // Drena o ledger (eventIngester.stop() faz o flush) + para timers de background.
  // TODO(live): aguardar tx in-flight confirmar antes do exit quando submeter de verdade.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      finalityTracker.stop();
      blockStalenessCheck.stop();
      processCheck.stop();
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
