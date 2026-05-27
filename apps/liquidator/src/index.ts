/**
 * ZEUS EVM Liquidator — pipeline de dispatch pra liquidations.
 *
 * Modo MVP (Sprint 1 — Aave only):
 *   - Boot conecta chain + (opcional) wallet
 *   - Cache `getMaxTradeFor(debtAsset)` pra assets conhecidos
 *   - Expõe `processOpportunity(position)` programática
 *   - Standalone demo: roda pipeline contra position-teste em DRY_RUN (validação de integração)
 *
 * Próxima sessão: discovery automática (resolve collateralAsset/debtAsset/bonus do borrower
 * via getUserConfiguration + getReserveData) + integração com monitor.
 */

import type { Address } from 'viem';
import { isAddress } from 'viem';

import { loadConfig } from './config';
import { logger } from './logger';
import { getChainContext, type LiquidatorChainContext } from './chainContext';
import { runAavePipeline, runCompoundPipeline } from './pipeline';
import { AavePriceOracle } from './protocols/aave/oracle';
import type {
  AaveLiquidatablePosition,
  CompoundLiquidatablePosition,
  DispatchOutcome,
} from './types';
import {
  buildAaveReservesCache,
  discoverAaveLiquidatablePositions,
  type AaveReservesCache,
} from '@zeus-evm/aave-discovery';
import {
  buildCompoundCometCache,
  type CompoundCometCache,
} from './protocols/compound/comets';
import { discoverCompoundLiquidatablePositions } from './protocols/compound/discovery';
import {
  slippageCache,
  PnlTracker,
  FailureTracker,
  PositionDedupTracker,
  GasReserveTracker,
  EventBus,
  GasOracle,
  TimeseriesStore,
  EventIngester,
  startHealthServer,
  PnlReconciler,
  FailureCollector,
  FinalityTracker,
  BlockStalenessCheck,
  ProcessCheck,
  AutoPauseManager,
  SenderRegistry,
  BlockHistoryScanner,
  Tracer,
  MetricRegistry,
  registerStandardMetrics,
  buildDigest,
  formatMarkdown,
  sendToDiscord,
  createDiscordSink,
  createGenericWebhookSink,
  type Severity,
  type ReadinessReport,
} from '@zeus-evm/execution-utils';
import { triggerKillSwitchOnChain } from './dispatcher';
import { resolve as resolvePath } from 'node:path';
import { parseEther } from 'viem';

// ABI fragment do executor pra cache de getMaxTradeFor
const EXECUTOR_VIEW_ABI = [
  {
    type: 'function',
    name: 'getMaxTradeFor',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'token' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

interface LiquidatorState {
  env: ReturnType<typeof loadConfig>;
  ctx: LiquidatorChainContext;
  callerAddress: Address;
  contractCapByDebtAsset: Map<string, bigint>;
  /** Cache de reserves Aave (decimals, bonus, etc) — buildado 1x no boot */
  aaveReservesCache?: AaveReservesCache;
  /** Cache de Comets Compound (collaterals + base token) — buildado 1x no boot */
  compoundCometCache?: CompoundCometCache;
  /** PnL tracker — rolling 24h + kill switch automático */
  pnlTracker: PnlTracker;
  /** Failure tracker — cooldown após N falhas consecutivas */
  failureTracker: FailureTracker;
  /** Dedup tracker — evita re-submeter mesma position */
  dedupTracker: PositionDedupTracker;
  /** Gas reserve tracker — monitora ETH balance da bot wallet */
  gasReserveTracker: GasReserveTracker;
  /** Event bus — emite eventos tipados pra webhooks/sinks externos */
  eventBus: EventBus;
  /** Gas oracle EIP-1559 — pricing correto pra Base/Arb/OP */
  gasOracle: GasOracle;
  /** Aave V3 PriceOracle — fonte canônica de preços USD pra calculator. */
  aaveOracle: AavePriceOracle;
  /** Historical intelligence store (DuckDB) — Item 15 do checklist 16-items. */
  intelligenceStore: TimeseriesStore;
  /** EventIngester — coleta automática de eventos pro dataset histórico. */
  eventIngester: EventIngester;
  /** PnL Reconciler (Item 10) — expected vs realized + attribution. */
  pnlReconciler: PnlReconciler;
  /** FailureCollector (Item 4) — schema rico em JSONL. */
  failureCollector: FailureCollector;
  /** FinalityTracker (Item 9) — detecção de reorg. */
  finalityTracker: FinalityTracker;
  /** BlockStalenessCheck (Item 12 H3). */
  blockStalenessCheck: BlockStalenessCheck;
  /** ProcessCheck (Item 12 H7). */
  processCheck: ProcessCheck;
  /** AutoPauseManager (Item 12 H10). */
  autoPauseManager: AutoPauseManager;
  /** SenderRegistry (Item 5) — perfis de competidores. */
  senderRegistry: SenderRegistry;
  /** BlockHistoryScanner (Item 5 F2) — popula registry em background. */
  blockHistoryScanner: BlockHistoryScanner;
  /** Tracer (Item 16B OB1) — spans correlacionados via trace_id. */
  tracer: Tracer;
  /** Prometheus MetricRegistry (Item 16B OB2). */
  metricRegistry: MetricRegistry;
}

/**
 * Boot do liquidator. Retorna state populated pronto pra processar oportunidades.
 */
export async function boot(): Promise<LiquidatorState> {
  const env = loadConfig();
  const ctx = getChainContext(env);

  // Em dryrun sem wallet, usa zero address como caller (eth_call funciona)
  const callerAddress = (ctx.account ??
    '0x0000000000000000000000000000000000000000') as Address;

  // PnL Tracker — em dryrun, autoKill é forçado false (estado interno é suficiente)
  const pnlTracker = new PnlTracker({
    dailyLossLimitUsd: env.DAILY_LOSS_LIMIT_USD,
    logFilePath: resolvePath(process.cwd(), env.PNL_LOG_FILE),
    autoKillEnabled: env.LIQUIDATOR_MODE !== 'dryrun' && env.AUTO_KILL_SWITCH_ENABLED,
    logger,
  });

  const pnlBootStats = pnlTracker.stats();
  logger.info(
    {
      windowH: 24,
      wins: pnlBootStats.wins,
      losses: pnlBootStats.losses,
      winsUsd: pnlBootStats.winsUsd.toFixed(2),
      lossesUsd: pnlBootStats.lossesUsd.toFixed(2),
      netPnlUsd: pnlBootStats.netPnlUsd.toFixed(2),
      dailyLimitUsd: env.DAILY_LOSS_LIMIT_USD,
      killSwitchTriggered: pnlBootStats.killSwitchTriggered,
    },
    `📊 PnL 24h | wins=$${pnlBootStats.winsUsd.toFixed(2)} losses=$${pnlBootStats.lossesUsd.toFixed(2)} net=$${pnlBootStats.netPnlUsd.toFixed(2)} | limit=$${env.DAILY_LOSS_LIMIT_USD}`,
  );

  if (pnlBootStats.killSwitchTriggered) {
    logger.fatal(
      { reason: pnlTracker.killReason() },
      `🚨 KILL SWITCH JÁ ATIVO na boot — dispatches futuros bloqueados. Use manualReset() apenas após auditoria.`,
    );
  }

  // Failure Tracker — contagem consecutiva pra cooldown automático
  const failureTracker = new FailureTracker({
    maxConsecutiveFailures: env.MAX_CONSECUTIVE_FAILURES,
    cooldownDurationMs: env.COOLDOWN_DURATION_SEC * 1000,
    logger,
  });

  logger.info(
    {
      maxFailures: env.MAX_CONSECUTIVE_FAILURES,
      cooldownSec: env.COOLDOWN_DURATION_SEC,
    },
    `🛡️ Failure tracker pronto — cooldown ${env.COOLDOWN_DURATION_SEC}s após ${env.MAX_CONSECUTIVE_FAILURES} falhas consecutivas`,
  );

  // Position Dedup Tracker — evita re-submit em ticks consecutivos
  const dedupTracker = new PositionDedupTracker({
    pendingTimeoutMs: env.DEDUP_PENDING_TIMEOUT_SEC * 1000,
    recentTtlMs: env.DEDUP_RECENT_TTL_SEC * 1000,
    logger,
  });

  logger.info(
    {
      pendingTimeoutSec: env.DEDUP_PENDING_TIMEOUT_SEC,
      recentTtlSec: env.DEDUP_RECENT_TTL_SEC,
    },
    `🔁 Dedup tracker pronto — pending=${env.DEDUP_PENDING_TIMEOUT_SEC}s, recent=${env.DEDUP_RECENT_TTL_SEC}s`,
  );

  // Gas Reserve Tracker — monitora ETH balance da bot wallet
  const gasReserveTracker = new GasReserveTracker({
    warnThresholdWei: parseEther(env.GAS_RESERVE_WARN_ETH.toString()),
    criticalThresholdWei: parseEther(env.GAS_RESERVE_CRITICAL_ETH.toString()),
    blockDispatchOnCritical: env.BLOCK_DISPATCH_ON_CRITICAL_GAS,
    ethUsdPrice: env.ETH_USD_PRICE_ESTIMATE,
    logger,
  });

  // Check inicial pra reportar estado no boot
  const initialGasStatus = await gasReserveTracker.check(ctx.client, ctx.account);
  const initialGasStats = gasReserveTracker.stats();
  logger.info(
    {
      account: ctx.account ?? '(none — dryrun)',
      status: initialGasStatus,
      balanceEth: initialGasStats.balanceEth,
      balanceUsd: initialGasStats.balanceUsd?.toFixed(2) ?? 'n/a',
      warnEth: env.GAS_RESERVE_WARN_ETH,
      criticalEth: env.GAS_RESERVE_CRITICAL_ETH,
    },
    `⛽ Gas reserve: ${initialGasStatus} | balance=${initialGasStats.balanceEth} ETH${initialGasStats.balanceUsd !== null ? ` ($${initialGasStats.balanceUsd.toFixed(2)})` : ''} | thresholds warn=${env.GAS_RESERVE_WARN_ETH} crit=${env.GAS_RESERVE_CRITICAL_ETH}`,
  );

  logger.info(
    {
      mode: env.LIQUIDATOR_MODE,
      chain: ctx.chainConfig.name,
      chainId: ctx.chainConfig.chainId,
      executor: ctx.executorContractAddress ?? '(não deployado)',
      walletAccount: ctx.account ?? '(none — dryrun)',
      minProfitUsd: env.MIN_LIQUIDATION_PROFIT_USD,
      maxSlippageBps: env.MAX_SLIPPAGE_BPS,
      pollIntervalSec: env.LIQUIDATOR_POLL_INTERVAL_SEC,
    },
    `🚀 Liquidator boot — mode=${env.LIQUIDATOR_MODE} chain=${ctx.chainConfig.name}`,
  );

  // Conectividade básica
  const blockNumber = await ctx.client.getBlockNumber();
  logger.info({ blockNumber: blockNumber.toString() }, `✅ Conectado em ${ctx.chainConfig.name}`);

  // Cache contractCap pra assets mais comuns na chain ativa
  const contractCapByDebtAsset = new Map<string, bigint>();
  if (ctx.executorContractAddress) {
    const commonAssets = getCommonDebtAssetsForChain(ctx.chainConfig.chainId);
    for (const asset of commonAssets) {
      try {
        const cap = (await ctx.client.readContract({
          address: ctx.executorContractAddress,
          abi: EXECUTOR_VIEW_ABI,
          functionName: 'getMaxTradeFor',
          args: [asset],
        })) as bigint;
        contractCapByDebtAsset.set(asset.toLowerCase(), cap);
        logger.debug({ asset, capWei: cap.toString() }, `cached cap: ${asset}`);
      } catch (err) {
        logger.warn(
          { asset, err: err instanceof Error ? err.message : err },
          `Falhou cache cap pra ${asset}`,
        );
      }
    }
    logger.info(
      { cachedCaps: contractCapByDebtAsset.size },
      `📦 Cache getMaxTradeFor: ${contractCapByDebtAsset.size} assets`,
    );
  }

  // Cache Aave reserves (decimals, bonus, etc) — só faz se chain tem aave.pool configurado
  let aaveReservesCache: AaveReservesCache | undefined;
  if (ctx.chainConfig.aave?.pool) {
    try {
      aaveReservesCache = await buildAaveReservesCache({
        client: ctx.client,
        poolAddress: ctx.chainConfig.aave.pool,
        chainId: ctx.chainConfig.chainId,
        logger,
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        `Falha ao buildar reserves cache Aave — discovery indisponível`,
      );
    }
  }

  // Cache Compound Comets — só faz se chain tem compoundV3 configurado
  let compoundCometCache: CompoundCometCache | undefined;
  const compoundCfg = ctx.chainConfig.compoundV3;
  if (compoundCfg) {
    const cometsList: Array<{ comet: Address; name: string }> = [];
    if (compoundCfg.cUSDCv3 && compoundCfg.cUSDCv3 !== '0x0000000000000000000000000000000000000000') {
      cometsList.push({ comet: compoundCfg.cUSDCv3 as Address, name: 'cUSDCv3' });
    }
    if (compoundCfg.cWETHv3 && compoundCfg.cWETHv3 !== '0x0000000000000000000000000000000000000000') {
      cometsList.push({ comet: compoundCfg.cWETHv3 as Address, name: 'cWETHv3' });
    }
    if (cometsList.length > 0) {
      try {
        compoundCometCache = await buildCompoundCometCache({
          client: ctx.client,
          chainId: ctx.chainConfig.chainId,
          comets: cometsList,
          logger,
        });
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : err },
          `Falha ao buildar Compound cometCache — Compound discovery indisponível`,
        );
      }
    }
  }

  // Gas Oracle EIP-1559 — pricing correto pra Base/Arb/OP/L2s modernas
  const gasOracle = new GasOracle({
    priorityFeeGwei: env.GAS_PRIORITY_FEE_GWEI,
    maxFeeMultiplier: env.GAS_MAX_FEE_MULTIPLIER,
    logger,
  });
  logger.info(
    {
      priorityFeeGwei: env.GAS_PRIORITY_FEE_GWEI,
      maxFeeMultiplier: env.GAS_MAX_FEE_MULTIPLIER,
    },
    `⛽ Gas oracle EIP-1559 pronto — priority=${env.GAS_PRIORITY_FEE_GWEI}gwei, multiplier=${env.GAS_MAX_FEE_MULTIPLIER}x`,
  );

  // Aave V3 PriceOracle — fonte canônica de preços USD pra calculator
  // (B-1, B-2, B-3 do audit 2026-05-26: antes assumia stable-peg em tudo).
  if (!ctx.chainConfig.aave?.oracle) {
    throw new Error(`chain ${ctx.chainConfig.name} sem Aave oracle configurado`);
  }
  const aaveOracle = new AavePriceOracle(ctx.client, ctx.chainConfig.aave.oracle);
  logger.info(
    { oracle: ctx.chainConfig.aave.oracle, chain: ctx.chainConfig.name },
    `🔮 Aave PriceOracle pronto`,
  );

  // Event Bus — subscriber-based emit/listen pra alertas + futuro WebSocket mobile
  const eventBus = new EventBus(logger);

  // Historical Intelligence — Item 15 I1+I2 (DuckDB + EventIngester)
  // Coleta de TODOS eventos pra dataset histórico (alimenta IA futura).
  const intelligenceStore = new TimeseriesStore({
    dbPath: resolvePath('logs', 'intelligence.duckdb'),
    logger,
  });
  await intelligenceStore.init();
  const eventIngester = new EventIngester({
    store: intelligenceStore,
    eventBus,
    logger,
    defaultChain: ctx.chainConfig.name,
  });
  eventIngester.start();

  // ── PnL Reconciler (Item 10) ──
  const pnlReconciler = new PnlReconciler({
    baseDir: resolvePath('logs', 'pnl-reconciliations'),
    logger,
  });
  logger.info('📊 PnlReconciler pronto');

  // ── FailureCollector (Item 4) ──
  const failureCollector = new FailureCollector({
    baseDir: resolvePath('logs', 'failures'),
    logger,
  });
  logger.info('📋 FailureCollector pronto');

  // ── Tracer (Item 16B OB1) ──
  const tracer = new Tracer({
    serviceName: 'liquidator',
    logger,
  });

  // ── Prometheus MetricRegistry (Item 16B OB2) ──
  const metricRegistry = new MetricRegistry({ logger });
  registerStandardMetrics(metricRegistry);
  logger.info({ definitions: metricRegistry.stats().definitions }, '📊 Prometheus registry pronto');

  // ── AutoPauseManager (Item 12 H10) ──
  const autoPauseManager = new AutoPauseManager({ logger });

  // ── FinalityTracker (Item 9 R1) ──
  const finalityTracker = new FinalityTracker({ client: ctx.client, logger });
  finalityTracker.onReorg((ev) => {
    // Em reorg crítico (depth >=3 ou circuit breaker), pausa dispatches
    if (ev.depth >= 3 || finalityTracker.isCircuitBreakerActive()) {
      autoPauseManager.setReason(
        'reorg',
        'critical',
        `reorg depth=${ev.depth} ancestor=${ev.commonAncestorBlock}`,
      );
      // Auto-clear após 5min
      setTimeout(() => autoPauseManager.clearReason('reorg'), 5 * 60 * 1000).unref();
    }
    // Invalida slippage cache (oracle cache by-block já se autoinvalida via fresh fetch)
    slippageCache.pruneExpired();
  });
  finalityTracker.start();
  logger.info('🔗 FinalityTracker iniciado');

  // ── BlockStalenessCheck (Item 12 H3) ──
  const blockStalenessCheck = new BlockStalenessCheck({
    client: ctx.client,
    logger,
  });
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

  // ── SenderRegistry + BlockHistoryScanner (Item 5 F1+F2) ──
  const senderRegistry = new SenderRegistry({
    baseDir: resolvePath('logs', 'competitors'),
    logger,
  });
  const scannerTargets = {
    aave_v3_pool: ctx.chainConfig.aave?.pool,
    compound_comets: [
      ctx.chainConfig.compoundV3?.cUSDCv3,
      ctx.chainConfig.compoundV3?.cWETHv3,
    ].filter((a): a is Address => !!a && a !== '0x0000000000000000000000000000000000000000'),
    morpho_blue: ctx.chainConfig.morpho?.morphoBlue,
    uniswap_v3_routers: [
      ctx.chainConfig.uniswapV3?.swapRouter02,
      ctx.chainConfig.uniswapV3?.universalRouter,
    ].filter((a): a is Address => !!a),
    aerodrome_router: ctx.chainConfig.aerodrome?.router,
  };
  const blockHistoryScanner = new BlockHistoryScanner({
    client: ctx.client,
    registry: senderRegistry,
    targets: scannerTargets,
    logger,
  });
  blockHistoryScanner.start();
  logger.info({ targets: Object.keys(scannerTargets).length }, '🔭 BlockHistoryScanner iniciado em background');

  // Health server — Item 12 H8+H11 (/healthz + /readyz pro UptimeRobot)
  if (env.HEALTH_SERVER_ENABLED) {
    startHealthServer({
      serviceName: 'liquidator',
      port: env.HEALTH_SERVER_PORT,
      host: env.HEALTH_SERVER_HOST,
      version: 'v8.2',
      logger,
      readinessProvider: () => buildLiquidatorReadinessReport({
        pnlTracker,
        failureTracker,
        dedupTracker,
        gasReserveTracker,
        intelligenceStore,
        eventIngester,
        autoPauseManager,
        finalityTracker,
        blockStalenessCheck,
        processCheck,
        senderRegistry,
        blockHistoryScanner,
        pnlReconciler,
        mode: env.LIQUIDATOR_MODE,
      }),
      metricsProvider: () => metricRegistry.render(),
    });
  }

  // Discord sink (se URL configurada)
  if (env.DISCORD_WEBHOOK_URL) {
    const severities = parseSeverities(env.DISCORD_SEVERITIES);
    eventBus.subscribe(
      createDiscordSink({
        webhookUrl: env.DISCORD_WEBHOOK_URL,
        severities,
        logger,
      }),
    );
    logger.info(
      { severities },
      `📢 Discord sink ativo — severidades: ${severities.join(',')}`,
    );
  }

  // Generic webhook sink (se URL configurada)
  if (env.GENERIC_WEBHOOK_URL) {
    const severities = parseSeverities(env.GENERIC_SEVERITIES);
    eventBus.subscribe(
      createGenericWebhookSink({
        url: env.GENERIC_WEBHOOK_URL,
        severities,
        logger,
      }),
    );
    logger.info(
      { severities },
      `📡 Generic webhook sink ativo — severidades: ${severities.join(',')}`,
    );
  }

  if (eventBus.subscriberCount() === 0) {
    logger.info('📭 Nenhum sink de alerta configurado (defina DISCORD_WEBHOOK_URL ou GENERIC_WEBHOOK_URL)');
  }

  // Sync periódico de gauges Prometheus (a cada 5s) — pega snapshots de trackers
  // Referencia variáveis locais (closure) em vez de state final pra evitar TDZ
  const metricsSyncInterval = setInterval(() => {
    try {
      const chain = ctx.chainConfig.name;
      // Health gauges
      const staleness = blockStalenessCheck.getStatus();
      metricRegistry.set('zeus_block_staleness_seconds', staleness.age_seconds, { chain });
      const proc = processCheck.getStatus();
      metricRegistry.set('zeus_uptime_seconds', proc.uptime_sec, { service: 'liquidator' });
      metricRegistry.set('zeus_process_memory_rss_mb', proc.memory_mb.rss, { service: 'liquidator' });
      metricRegistry.set('zeus_event_loop_lag_ms', proc.event_loop_lag_ms, { service: 'liquidator' });
      // PnL
      const pnlStats = pnlTracker.stats();
      metricRegistry.set('zeus_pnl_realized_usd_total', pnlStats.netPnlUsd, { chain, protocol: 'all' });
      // Gas reserve
      const gasStats = gasReserveTracker.stats();
      metricRegistry.set('zeus_gas_reserve_eth', Number(gasStats.balanceEth ?? 0), { chain, account: callerAddress });
      // Reorg
      const finStats = finalityTracker.stats();
      metricRegistry.set('zeus_reorgs_in_window', finStats.reorgsInWindow, { chain });
      // Auto-pause
      const pauseStatus = autoPauseManager.status();
      metricRegistry.set('zeus_auto_pause_active', pauseStatus.paused ? 1 : 0, { service: 'liquidator' });
      metricRegistry.set('zeus_auto_pause_reasons', pauseStatus.reasons.length, { service: 'liquidator' });
      // Dedup
      const dedupStats = dedupTracker.stats();
      metricRegistry.set('zeus_dedup_pending', dedupStats.pending, { chain });
      metricRegistry.set('zeus_dedup_confirmed', dedupStats.confirmed, { chain });
      // Competitor scanner
      const scannerStats = blockHistoryScanner.getStats();
      metricRegistry.set('zeus_competitor_profiles_total', scannerStats.unique_senders, { chain });
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : err },
        'metrics sync: erro (drop silencioso)',
      );
    }
  }, 5_000);
  metricsSyncInterval.unref();

  // PnL Reporter — Item 10 P7 (daily digest pra Discord)
  if (env.PNL_REPORTER_ENABLED && env.PNL_REPORTER_WEBHOOK_URL) {
    schedulePnlDigest({
      reconciler: pnlReconciler,
      webhookUrl: env.PNL_REPORTER_WEBHOOK_URL,
      hourUtc: env.PNL_REPORTER_HOUR_UTC,
      logger,
    });
    logger.info(
      { hourUtc: env.PNL_REPORTER_HOUR_UTC },
      `📊 PnL daily digest agendado pra ${env.PNL_REPORTER_HOUR_UTC}h UTC`,
    );
  }

  // Emite evento de boot pra notificar subscribers
  eventBus.emit({
    type: 'liquidator.boot',
    timestamp: new Date().toISOString(),
    chain: ctx.chainConfig.name,
    mode: env.LIQUIDATOR_MODE,
    severity: 'info',
    executorAddress: ctx.executorContractAddress ?? null,
    account: ctx.account ?? null,
  });

  return {
    env,
    ctx,
    callerAddress,
    contractCapByDebtAsset,
    aaveReservesCache,
    compoundCometCache,
    pnlTracker,
    failureTracker,
    dedupTracker,
    gasReserveTracker,
    eventBus,
    gasOracle,
    aaveOracle,
    intelligenceStore,
    eventIngester,
    pnlReconciler,
    failureCollector,
    finalityTracker,
    blockStalenessCheck,
    processCheck,
    autoPauseManager,
    senderRegistry,
    blockHistoryScanner,
    tracer,
    metricRegistry,
  };
}

/** Parsea string "info,warn,critical" pra array de Severity. */
function parseSeverities(raw: string): Severity[] {
  const valid: Severity[] = ['info', 'warn', 'critical'];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Severity => valid.includes(s as Severity));
}

/**
 * Agenda PnL daily digest pra rodar diariamente no horário UTC configurado.
 * Item 10 P7 do checklist 16-items.
 *
 * Estratégia:
 *  - Calcula tempo até próxima ocorrência da `hourUtc` configurada
 *  - setTimeout pra essa primeira execução
 *  - Depois setInterval 24h pra repetir
 *
 * Falhas no envio NÃO derrubam o bot (try/catch interno do sendToDiscord).
 */
function schedulePnlDigest(opts: {
  reconciler: PnlReconciler;
  webhookUrl: string;
  hourUtc: number;
  logger: typeof logger;
}): void {
  const runDigest = async () => {
    try {
      const digest = buildDigest(opts.reconciler, { period: 'daily' });
      const markdown = formatMarkdown(digest);
      await sendToDiscord(opts.webhookUrl, markdown, opts.logger);
    } catch (err) {
      opts.logger.warn(
        { err: err instanceof Error ? err.message : err },
        'PnL daily digest: erro gerando/enviando (drop silencioso)',
      );
    }
  };

  // Calcula ms até próxima ocorrência da hora UTC
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    opts.hourUtc,
    0,
    0,
  ));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1); // próxima ocorrência amanhã
  }
  const msUntilNext = next.getTime() - now.getTime();

  setTimeout(() => {
    void runDigest();
    // Depois roda a cada 24h
    const interval = setInterval(() => void runDigest(), 24 * 60 * 60 * 1000);
    interval.unref();
  }, msUntilNext).unref();
}

/**
 * Constrói snapshot de readiness pro health endpoint `/readyz`.
 * Cada componente reporta seu estado — qualquer 'critical' resulta em HTTP 503.
 */
function buildLiquidatorReadinessReport(deps: {
  pnlTracker: PnlTracker;
  failureTracker: FailureTracker;
  dedupTracker: PositionDedupTracker;
  gasReserveTracker: GasReserveTracker;
  intelligenceStore: TimeseriesStore;
  eventIngester: EventIngester;
  autoPauseManager: AutoPauseManager;
  finalityTracker: FinalityTracker;
  blockStalenessCheck: BlockStalenessCheck;
  processCheck: ProcessCheck;
  senderRegistry: SenderRegistry;
  blockHistoryScanner: BlockHistoryScanner;
  pnlReconciler: PnlReconciler;
  mode: string;
}): ReadinessReport {
  const pnlStats = deps.pnlTracker.stats();
  const failureStats = deps.failureTracker.stats();
  const dedupStats = deps.dedupTracker.stats();
  const gasStats = deps.gasReserveTracker.stats();
  const intelStats = deps.intelligenceStore.stats();
  const ingestStats = deps.eventIngester.getStats();
  const pauseStatus = deps.autoPauseManager.status();
  const finalityStats = deps.finalityTracker.stats();
  const staleness = deps.blockStalenessCheck.getStatus();
  const procHealth = deps.processCheck.getStatus();
  const scannerStats = deps.blockHistoryScanner.getStats();
  const reconStats = deps.pnlReconciler.stats();

  const checks: Record<string, import('@zeus-evm/execution-utils').ComponentCheck> = {
    pnl: {
      ok: !pnlStats.killSwitchTriggered,
      reason: pnlStats.killSwitchTriggered ? pnlStats.killSwitchReason : undefined,
      netPnlUsd24h: pnlStats.netPnlUsd,
      wins24h: pnlStats.wins,
      losses24h: pnlStats.losses,
    },
    failure: {
      ok: !failureStats.inCooldown,
      reason: failureStats.inCooldown ? `cooldown ${failureStats.cooldownRemainingMs}ms` : undefined,
      consecutiveFailures: failureStats.consecutiveFailures,
    },
    dedup: {
      ok: true,
      pending: dedupStats.pending,
      confirmed: dedupStats.confirmed,
      failed: dedupStats.failed,
    },
    gas_reserve: {
      ok: gasStats.status !== 'critical',
      reason: gasStats.status,
      balanceEth: gasStats.balanceEth,
      balanceUsd: gasStats.balanceUsd,
    },
    intelligence_store: {
      ok: intelStats.flushErrors < 10,
      reason: intelStats.flushErrors >= 10 ? `${intelStats.flushErrors} flush errors` : undefined,
      totalEvents: intelStats.totalEvents,
      pendingWrites: intelStats.pendingWrites,
      lastFlushAt: intelStats.lastFlushAt,
    },
    event_ingester: {
      ok: ingestStats.errors < 10,
      reason: ingestStats.errors >= 10 ? `${ingestStats.errors} ingester errors` : undefined,
      eventsIngested: ingestStats.eventsIngested,
      eventsDropped: ingestStats.eventsDropped,
    },
    block_staleness: {
      ok: staleness.status !== 'critical',
      reason: staleness.status,
      ageSec: staleness.age_seconds.toFixed(1),
      latestBlock: staleness.latest_block_number?.toString(),
    },
    process: {
      ok: procHealth.status !== 'critical',
      reason: procHealth.status,
      memoryRssMb: procHealth.memory_mb.rss.toFixed(0),
      eventLoopLagMs: procHealth.event_loop_lag_ms.toFixed(1),
      uptimeSec: procHealth.uptime_sec,
    },
    finality: {
      ok: !finalityStats.circuitBreakerActive,
      reason: finalityStats.circuitBreakerActive ? 'reorg circuit breaker active' : undefined,
      trackedBlocks: finalityStats.trackedBlocks,
      reorgsLifetime: finalityStats.reorgsLifetime,
      reorgsInWindow: finalityStats.reorgsInWindow,
    },
    competitor_scanner: {
      ok: scannerStats.errors < 20,
      blocksProcessed: scannerStats.blocks_processed,
      uniqueSenders: scannerStats.unique_senders,
      txsMatched: scannerStats.txs_matched_targets,
    },
    pnl_reconciler: {
      ok: true,
      totalReconciliations: reconStats.totalReconciliations,
      netDeltaUsd: reconStats.netDeltaUsd.toFixed(2),
      avgDriftBps: reconStats.avgDriftBps,
      withinNormalBand: reconStats.withinNormalBandCount,
    },
    auto_pause: {
      ok: !pauseStatus.hard_pause,
      reason: pauseStatus.paused ? deps.autoPauseManager.summary() : undefined,
      activeReasons: pauseStatus.reasons.length,
    },
  };

  // Agregar status global
  const anyCritical = pauseStatus.hard_pause || pnlStats.killSwitchTriggered || staleness.status === 'critical' || procHealth.status === 'critical';
  const anyDegraded = Object.values(checks).some((c) => !c.ok);

  return {
    status: anyCritical ? 'critical' : anyDegraded ? 'degraded' : 'ok',
    checks,
    dispatchesPaused: pauseStatus.paused || pnlStats.killSwitchTriggered || failureStats.inCooldown,
    pausedReasons: [
      ...(pnlStats.killSwitchTriggered ? [`kill_switch: ${pnlStats.killSwitchReason}`] : []),
      ...(failureStats.inCooldown ? [`cooldown ${failureStats.cooldownRemainingMs}ms`] : []),
      ...pauseStatus.reasons.map((r) => `${r.source}: ${r.message}`),
      ...(deps.mode === 'dryrun' ? ['dryrun (no dispatches submitted)'] : []),
    ],
  };
}

/**
 * Roda o pipeline Aave contra uma oportunidade já discovered.
 * API programática — chamável de scripts externos OU futuro integração com monitor.
 */
export async function processOpportunity(
  position: AaveLiquidatablePosition,
  state: LiquidatorState,
): Promise<DispatchOutcome> {
  return runAavePipeline(position, {
    env: state.env,
    ctx: state.ctx,
    callerAddress: state.callerAddress,
    contractCapByDebtAsset: state.contractCapByDebtAsset,
    pnlTracker: state.pnlTracker,
    failureTracker: state.failureTracker,
    dedupTracker: state.dedupTracker,
    gasReserveTracker: state.gasReserveTracker,
    eventBus: state.eventBus,
    gasOracle: state.gasOracle,
    aaveOracle: state.aaveOracle,
    pnlReconciler: state.pnlReconciler,
    failureCollector: state.failureCollector,
    autoPauseManager: state.autoPauseManager,
  });
}

/**
 * Roda o pipeline Compound contra uma oportunidade já discovered.
 */
export async function processCompoundOpportunity(
  position: CompoundLiquidatablePosition,
  state: LiquidatorState,
): Promise<DispatchOutcome> {
  return runCompoundPipeline(position, {
    env: state.env,
    ctx: state.ctx,
    callerAddress: state.callerAddress,
    contractCapByDebtAsset: state.contractCapByDebtAsset,
    pnlTracker: state.pnlTracker,
    failureTracker: state.failureTracker,
    dedupTracker: state.dedupTracker,
    gasReserveTracker: state.gasReserveTracker,
    eventBus: state.eventBus,
    gasOracle: state.gasOracle,
    aaveOracle: state.aaveOracle,
    pnlReconciler: state.pnlReconciler,
    failureCollector: state.failureCollector,
    autoPauseManager: state.autoPauseManager,
  });
}

/** Lista de debt assets comuns por chain pra warm-up do cache de cap. */
function getCommonDebtAssetsForChain(chainId: number): Address[] {
  // Endereços canônicos USDC/USDT/WETH/etc. Mainnet only por enquanto.
  switch (chainId) {
    case 8453: // Base
      return [
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC native
        '0x4200000000000000000000000000000000000006', // WETH
        '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      ];
    case 42161: // Arbitrum
      return [
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC native
        '0xfd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT
        '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
      ];
    case 10: // Optimism
      return [
        '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // USDC native
        '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // USDT
        '0x4200000000000000000000000000000000000006', // WETH
      ];
    default:
      return [];
  }
}

/**
 * Tick de discovery: busca candidatos no subgraph, filtra HF on-chain, resolve par
 * (collateral, debt) dominante, roda pipeline pra cada position liquidável.
 *
 * Em DRY_RUN: tudo loga sem submeter tx.
 * Em testnet/mainnet: positions com simulação OK viram tx submetidas.
 */
export async function discoveryTick(state: LiquidatorState): Promise<void> {
  const { env, ctx, aaveReservesCache, compoundCometCache } = state;

  const startedAt = Date.now();
  const stats = { aave: 0, compound: 0, dispatched: 0, dryrun: 0, rejected: 0 };

  // Check gas reserve antes de qualquer trabalho — atualiza estado interno
  await state.gasReserveTracker.check(ctx.client, ctx.account);

  // ─── Aave V3 ───
  if (aaveReservesCache && env.THEGRAPH_API_KEY && ctx.chainConfig.aave?.pool) {
    try {
      const aavePositions = await discoverAaveLiquidatablePositions({
        client: ctx.client,
        poolAddress: ctx.chainConfig.aave.pool,
        apiKey: env.THEGRAPH_API_KEY,
        subgraphId: ctx.subgraphId,
        cache: aaveReservesCache,
        hfThreshold: env.HF_AT_RISK_THRESHOLD,
        maxCandidates: 200,
        logger,
      });
      stats.aave = aavePositions.length;
      for (const position of aavePositions) {
        const outcome = await processOpportunity(position, state);
        updateStats(stats, outcome.status);
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Aave discovery falhou');
    }
  } else if (!aaveReservesCache) {
    logger.debug('aaveReservesCache ausente — Aave discovery pulado');
  }

  // ─── Compound III ───
  if (compoundCometCache && compoundCometCache.comets.length > 0) {
    try {
      const compoundPositions = await discoverCompoundLiquidatablePositions({
        client: ctx.client,
        cache: compoundCometCache,
        blockLookback: 10_000, // free tier safe
        logger,
      });
      stats.compound = compoundPositions.length;
      for (const position of compoundPositions) {
        const outcome = await processCompoundOpportunity(position, state);
        updateStats(stats, outcome.status);
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Compound discovery falhou');
    }
  } else if (!compoundCometCache) {
    logger.debug('compoundCometCache ausente — Compound discovery pulado');
  }

  // Stats do cache de slippage (pra observar hit rate)
  const cacheStats = slippageCache.stats();
  // Reset stats por tick pra ver evolução
  slippageCache.resetStats();
  // Pruning oportunístico — barato (TTL check)
  const pruned = slippageCache.pruneExpired();

  // PnL stats do tick + kill switch check
  const pnlStats = state.pnlTracker.stats();
  const failureStats = state.failureTracker.stats();
  const dedupPruned = state.dedupTracker.pruneExpired();
  const dedupStats = state.dedupTracker.stats();
  const gasStats = state.gasReserveTracker.stats();
  // Se tracker virou triggered durante este tick (e não foi acionado ANTES), disparar kill on-chain
  if (
    pnlStats.killSwitchTriggered &&
    state.env.AUTO_KILL_SWITCH_ENABLED &&
    state.env.LIQUIDATOR_MODE !== 'dryrun' &&
    ctx.executorContractAddress
  ) {
    try {
      const killResult = await triggerKillSwitchOnChain({
        mode: state.env.LIQUIDATOR_MODE,
        client: ctx.client,
        wallet: ctx.wallet,
        account: ctx.account,
        executorAddress: ctx.executorContractAddress,
        reason: state.pnlTracker.killReason() ?? 'daily loss limit exceeded',
      });
      logger.fatal(
        { killResult },
        `⛔ Auto-kill on-chain status: ${killResult.status}`,
      );
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        'Falha ao acionar kill on-chain — tracker continua bloqueando dispatches em memória',
      );
    }
  }

  if (stats.aave === 0 && stats.compound === 0) {
    logger.info(
      { elapsedMs: Date.now() - startedAt, cache: cacheStats, prunedEntries: pruned },
      '✅ Discovery: 0 positions at-risk total',
    );
    return;
  }

  logger.info(
    {
      aavePositions: stats.aave,
      compoundPositions: stats.compound,
      dispatched: stats.dispatched,
      dryrun: stats.dryrun,
      rejected: stats.rejected,
      elapsedMs: Date.now() - startedAt,
      cacheHits: cacheStats.hits,
      cacheMisses: cacheStats.misses,
      cacheHitRate: `${(cacheStats.hitRate * 100).toFixed(1)}%`,
      cacheSize: cacheStats.size,
      cachePruned: pruned,
      pnlNetUsd: pnlStats.netPnlUsd.toFixed(2),
      pnlLossesUsd: pnlStats.lossesUsd.toFixed(2),
      pnlWinsUsd: pnlStats.winsUsd.toFixed(2),
      killSwitch: pnlStats.killSwitchTriggered ? 'TRIGGERED' : 'ok',
      consecutiveFailures: `${failureStats.consecutiveFailures}/${failureStats.maxAllowed}`,
      cooldown: failureStats.inCooldown
        ? `${Math.ceil(failureStats.cooldownRemainingMs / 1000)}s`
        : 'ok',
      dedupTotal: dedupStats.total,
      dedupPending: dedupStats.pending,
      dedupConfirmed: dedupStats.confirmed,
      dedupFailed: dedupStats.failed,
      dedupPruned,
      gasStatus: gasStats.status,
      gasBalanceEth: gasStats.balanceEth,
      gasBalanceUsd: gasStats.balanceUsd?.toFixed(2) ?? 'n/a',
    },
    `🔄 Tick done: aave=${stats.aave} compound=${stats.compound} | dispatched=${stats.dispatched} dryrun=${stats.dryrun} rejected=${stats.rejected} | cache=${cacheStats.hits}/${cacheStats.hits + cacheStats.misses} (${(cacheStats.hitRate * 100).toFixed(0)}%) | PnL24h net=$${pnlStats.netPnlUsd.toFixed(2)} (loss=$${pnlStats.lossesUsd.toFixed(2)}) | fails=${failureStats.consecutiveFailures}/${failureStats.maxAllowed}${failureStats.inCooldown ? ` ⏸️ cd=${Math.ceil(failureStats.cooldownRemainingMs / 1000)}s` : ''} | dedup=${dedupStats.total} (p=${dedupStats.pending} c=${dedupStats.confirmed} f=${dedupStats.failed}) | gas=${gasStats.status} ${gasStats.balanceEth}ETH`,
  );

  // Emit tick event pra subscribers (Discord filtra fora por default — só generic webhook recebe)
  state.eventBus.emit({
    type: 'discovery.tick_completed',
    timestamp: new Date().toISOString(),
    chain: ctx.chainConfig.name,
    mode: state.env.LIQUIDATOR_MODE,
    severity: 'info',
    aavePositions: stats.aave,
    compoundPositions: stats.compound,
    dispatched: stats.dispatched,
    dryrun: stats.dryrun,
    rejected: stats.rejected,
    elapsedMs: Date.now() - startedAt,
  });
}

function updateStats(
  stats: { dispatched: number; dryrun: number; rejected: number },
  status: DispatchOutcome['status'],
): void {
  switch (status) {
    case 'confirmed':
    case 'submitted':
      stats.dispatched++;
      break;
    case 'dryrun_skipped':
      stats.dryrun++;
      break;
    default:
      stats.rejected++;
  }
}

/**
 * Standalone entry point — quando rodado via `tsx src/index.ts` (pnpm start).
 * Faz boot, opcionalmente roda demo, e entra em loop de polling chamando discoveryTick.
 */
async function main() {
  const state = await boot();

  if (process.env.LIQUIDATOR_STANDALONE_DEMO === 'true') {
    logger.info('🎯 STANDALONE_DEMO ativo — rodando pipeline contra position-teste');
    await runStandaloneDemo(state);
  }

  // Discovery loop (Caminho A: polling a cada N segundos)
  logger.info(
    {
      mode: state.env.LIQUIDATOR_MODE,
      intervalSec: state.env.LIQUIDATOR_POLL_INTERVAL_SEC,
    },
    `🔁 Discovery loop ATIVO — polling ${state.env.LIQUIDATOR_POLL_INTERVAL_SEC}s`,
  );

  // Tick imediato + tick periódico
  try {
    await discoveryTick(state);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'tick #0 falhou');
  }

  setInterval(() => {
    discoveryTick(state).catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : err }, 'tick falhou'),
    );
  }, state.env.LIQUIDATOR_POLL_INTERVAL_SEC * 1000);

  // Mantém processo vivo
  await new Promise(() => {});
}

/** Demo pra validar integração de todos os componentes em DRY_RUN. */
async function runStandaloneDemo(state: LiquidatorState): Promise<void> {
  const fakeBorrower = '0x' + 'de'.repeat(20) as Address;
  if (!isAddress(fakeBorrower)) return;

  // Position mock: $1000 debt USDC + $1100 collateral WETH em Base mainnet
  // Valores realistas que deveriam disparar pipeline mas reverter por position não existir on-chain
  const mockPosition: AaveLiquidatablePosition = {
    borrower: fakeBorrower,
    collateralAsset: '0x4200000000000000000000000000000000000006', // WETH Base
    debtAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',         // USDC Base
    totalDebtWei: 1000n * 1_000_000n,       // $1000 USDC (6 dec)
    totalCollateralWei: 5n * 10n ** 17n,     // 0.5 WETH (18 dec, ~$1500)
    healthFactor: 950n * 10n ** 15n,         // HF = 0.95 (liquidable)
    liquidationBonusBps: 750,                // 7.5% bonus
    debtAssetDecimals: 6,
    collateralAssetDecimals: 18,
    debtAssetSymbol: 'USDC',
    collateralAssetSymbol: 'WETH',
  };

  logger.info(
    {
      borrower: mockPosition.borrower,
      debt: '1000 USDC',
      collateral: '0.5 WETH',
      hf: '0.95',
    },
    'Mock position pra demo',
  );

  const outcome = await processOpportunity(mockPosition, state);
  logger.info({ outcome }, `Demo outcome: ${outcome.status}`);
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.stack : err }, 'fatal');
  process.exit(1);
});
