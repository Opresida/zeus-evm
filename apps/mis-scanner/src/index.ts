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
  StrategyStatsTracker,
  VettingUniverseTracker,
  EventBus,
  EventIngester,
  createGenericWebhookSink,
  type Severity,
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
  findTriangularCycles,
  BribeTracker,
  shouldAutoEnableCompetitiveBribe,
  // Defesas de maturidade (paridade Motor 1) — todas de execution-utils.
  AutoPauseManager,
  FinalityTracker,
  OrphanRecoveryManager,
  TxStateMachine,
  ReorgAnalytics,
  BlockStalenessCheck,
  ProcessCheck,
  LatencyTracker,
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
import { runVettingObserve } from './vettingObserve';
import { optimizeFlashLoan, fetchEthUsd, fetchTokenUsd } from './flashEstimator';
import { loadConfig } from './config';
import { findFreshArb } from './execution/arbOpportunity';
import { dispatchArb, type ArbDispatchDeps } from './execution/arbDispatcher';
import { runFillerTick } from './uniswapx/runner';
import { baseTokenMeta } from './uniswapx/tokens';
import { fetchEngineControlEnabled } from './engineControl';

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

  // ─── Ponte pro painel (ZEUS Command) — sem isto, NADA do Motor 2 chega ao front ───
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
    logger.info({ severities, auth: env.GENERIC_WEBHOOK_SECRET ? 'x-zeus-secret' : 'none' }, '📡 Generic webhook sink ativo (Motor 2 → painel)');
  }
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
  // Gorjeta competitiva (Motor 2): tracker do último bribe + estado mutável do auto-liga.
  // `bribeAutoState` é a MESMA referência passada ao dispatcher — o detector periódico abaixo
  // seta `.enabled=true` quando há evidência de gas_outbid, e o dispatch passa a usar a gorjeta.
  const bribeTracker = new BribeTracker();
  const bribeAutoState = { enabled: false, reason: '', sinceIso: '', outbidCount: 0 };
  logger.info('🧠 Camada de inteligência do Motor 2 pronta (competidores + PnL + calibração + post-mortem)');

  // ─── Defesas de maturidade (paridade com o Motor 1) — REUSO de execution-utils, dormentes em DRY_RUN ───
  // Saúde → pausa: o health server (abaixo) ganha "sensores" reais; sem isto ele responde mas nada pausa o bot.
  const autoPauseManager = new AutoPauseManager({ logger });
  const txStateMachine = new TxStateMachine({ logger });
  const orphanRecoveryManager = new OrphanRecoveryManager({ txStateMachine, logger });
  const reorgAnalytics = new ReorgAnalytics({ logger });
  const latencyTracker = new LatencyTracker();
  // Reorg → pausa crítica + recovery de tx órfã (mesmo encadeamento do liquidator).
  const finalityTracker = new FinalityTracker({ client, logger });
  finalityTracker.onReorg(async (ev) => {
    if (ev.depth >= 3 || finalityTracker.isCircuitBreakerActive()) {
      autoPauseManager.setReason('reorg', 'critical', `reorg depth=${ev.depth} ancestor=${ev.commonAncestorBlock}`);
      setTimeout(() => autoPauseManager.clearReason('reorg'), 5 * 60 * 1000).unref();
    }
    reorgAnalytics.observe(ev);
    await orphanRecoveryManager.onReorg(ev); // dormente em DRY_RUN (sem tx real registrada)
  });
  finalityTracker.start();
  // Bloco travado (sem novo bloco > limite) → pausa.
  const blockStalenessCheck = new BlockStalenessCheck({ client, logger });
  blockStalenessCheck.onStatusChange((r) => {
    if (r.status === 'critical') autoPauseManager.setReason('block_staleness', 'critical', `${r.age_seconds.toFixed(0)}s sem bloco`);
    else autoPauseManager.clearReason('block_staleness');
  });
  blockStalenessCheck.start();
  // Saúde do processo (memória/event-loop lag) → pausa.
  const processCheck = new ProcessCheck({ logger });
  processCheck.onStatusChange((p) => {
    if (p.status === 'critical') autoPauseManager.setReason('process', 'critical', `mem ${p.memory_mb.rss.toFixed(0)}MB lag ${p.event_loop_lag_ms.toFixed(0)}ms`);
    else autoPauseManager.clearReason('process');
  });
  processCheck.start();
  logger.info('🛡️ Defesas de maturidade do Motor 2 prontas (reorg + auto-pause de saúde + latência)');

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
        // dispatchesPaused = execução armada mas TRAVADA (toggle remoto OFF). O Frontend lê isto
        // (via heartbeat/health) pra mostrar o estado REAL do bot vs o estado desejado no painel.
        readinessProvider: () => {
          const armed = !!arbExec && arbExec.deps.mode !== 'dryrun';
          const live = !!arbExec?.deps.liveExecutionEnabled;
          const lockedOff = armed && !live;
          // Pausa de saúde/reorg (sensores reais) OU toggle remoto OFF — ambos travam o dispatch.
          const healthPaused = autoPauseManager.shouldPause();
          const paused = lockedOff || healthPaused;
          const reasons: string[] = [];
          if (lockedOff) reasons.push('execution_locked (toggle remoto OFF)');
          if (healthPaused) reasons.push(autoPauseManager.summary());
          return {
            status: 'ok',
            checks: {},
            dispatchesPaused: paused,
            pausedReasons: reasons,
          };
        },
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

  // ── Porteiro de tokens (Etapas 2-3) — VETA antes de registrar (pra poder FILTRAR no enforce) ──
  // Estado AO VIVO do filtro (boot + poll do toggle); lido pelo heartbeat (badge) e pelo gate de execução.
  const vettingTracker = new VettingUniverseTracker();
  const vettingEnforce = { m2: false };
  if (env.VETTING_ENABLED) {
    if (env.VETTING_M2_ENFORCE) {
      vettingEnforce.m2 = await fetchEngineControlEnabled({
        supabaseUrl: env.SUPABASE_URL,
        supabaseKey: env.SUPABASE_KEY,
        motor: 'vetting_m2_enforce',
      });
    }
    if (env.VETTING_M2_OBSERVE) {
      const usdc = chainConfig.tokens?.USDC as `0x${string}` | undefined;
      if (usdc) {
        await runVettingObserve({
          groups,
          client,
          chainConfig,
          quoteToken: usdc,
          quoteTokenDecimals: 6,
          eventBus,
          tracker: vettingTracker,
          mode: env.ARB_MODE,
          safetyCacheDir: env.VETTING_SAFETY_CACHE_DIR,
          logger,
          enforce: vettingEnforce.m2,
        }).catch((err) => logger.warn({ err: String(err) }, 'vetting observe falhou — ignorado (não bloqueia o boot)'));
      } else {
        logger.warn('vetting: sem USDC no chain-config desta chain — vetting pulado');
      }
    }
  }

  // Registra os grupos. Filtro LIGADO → pula grupos cujo token reprovou no porteiro (M2). Fora do universo de scan.
  const groupVettedOut = (g: (typeof groups)[number]) =>
    vettingEnforce.m2 &&
    (vettingTracker.current(g.tokenA, 'motor2')?.verdict === 'reject' ||
      vettingTracker.current(g.tokenB, 'motor2')?.verdict === 'reject');
  let vettingSkipped = 0;
  for (const g of groups) {
    if (groupVettedOut(g)) {
      vettingSkipped++;
      continue;
    }
    mis.registerGroup(g);
  }
  if (vettingSkipped) {
    logger.warn({ skipped: vettingSkipped }, `🛂 filtro M2 LIGADO: ${vettingSkipped} grupos fora do universo (token reprovado)`);
  }

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
        // Armado-mas-travado: sobe SEMPRE travado (fail-safe). Só o toggle remoto liga.
        liveExecutionEnabled: false,
        // Inteligência (Parte B): reconciliação, falhas, post-mortem, eventos.
        pnlTracker, failureTracker, pnlReconciler, failureCollector, eventBus,
        competitorResolver, blockPositionTracker,
        // Gorjeta competitiva (limitada por lucro) — opt-in OU auto-ligada pelo detector abaixo.
        competitiveBribeEnabled: env.COMPETITIVE_BRIBE_ENABLED,
        bribeTargetPercentile: env.BRIBE_TARGET_PERCENTILE,
        maxBribeWei: BigInt(Math.floor(env.MAX_BRIBE_GWEI * 1e9)),
        senderRegistry, bribeTracker, bribeAutoState,
        // Defesas de maturidade (paridade Motor 1): gate de pausa + reorg recovery + latência.
        autoPauseManager, txStateMachine, orphanRecoveryManager, latencyTracker,
      },
    };
    const remoteControlled = mode !== 'dryrun' && !!env.SUPABASE_URL;
    logger.info(
      { mode, executor: env.ARB_EXECUTOR_ADDRESS ?? '(ausente)', topN: env.ARB_TOP_N, remoteControlled, locked: true },
      `⚙️ Execução de ARB ARMADA (mode=${mode}) — envio TRAVADO até toggle remoto${remoteControlled ? '' : ' (sem SUPABASE_URL → travado permanente, fail-safe)'}`,
    );
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

  // ─── Detector do auto-liga da gorjeta competitiva (Motor 2) ───
  // A cada 5 min: conta quantas corridas perdemos por gás (gas_outbid) na janela. Se passar do
  // limiar e a feature ainda estiver desligada, o ZEUS LIGA sozinho a gorjeta competitiva — que já é
  // LIMITADA POR LUCRO (nunca prejuízo). Sticky na sessão; o operador é avisado no painel (heartbeat
  // + evento). Não persiste em engine_control; opt-in via config (COMPETITIVE_BRIBE_ENABLED) continua valendo.
  const bribeAutoDetector = setInterval(() => {
    try {
      if (!arbExec || bribeAutoState.enabled || env.COMPETITIVE_BRIBE_ENABLED) return; // já ligado/forçado
      const windowMs = env.BRIBE_AUTO_ENABLE_WINDOW_MIN * 60_000;
      const cutoff = Date.now() - windowMs;
      const outbidCount = failureCollector
        .recent(500)
        .filter((f) => f.category === 'gas_outbid' && f.timestamp >= cutoff).length;
      if (!shouldAutoEnableCompetitiveBribe({ outbidCount, threshold: env.BRIBE_AUTO_ENABLE_THRESHOLD })) return;

      const reason = `${outbidCount} corridas perdidas no gás na última ${env.BRIBE_AUTO_ENABLE_WINDOW_MIN} min`;
      bribeAutoState.enabled = true;
      bribeAutoState.reason = reason;
      bribeAutoState.sinceIso = new Date().toISOString();
      bribeAutoState.outbidCount = outbidCount;
      logger.warn(
        { outbidCount, threshold: env.BRIBE_AUTO_ENABLE_THRESHOLD, windowMin: env.BRIBE_AUTO_ENABLE_WINDOW_MIN },
        `⚡ ZEUS LIGOU a gorjeta competitiva sozinho — ${reason} (dentro do lucro, nunca no vermelho)`,
      );
      eventBus.emit({
        type: 'calibration.applied', timestamp: new Date().toISOString(), chain: chainConfig.name,
        mode: arbExec.deps.mode ?? 'dryrun', severity: 'info', dimension: 'bribe-competitivo',
        oldThresholdUsd: 0, newThresholdUsd: 0,
        reason: `gorjeta competitiva auto-ligada: ${reason}`,
      });
    } catch (err) {
      logger.debug?.({ err: err instanceof Error ? err.message : err }, 'bribe auto-detector: erro (drop)');
    }
  }, 5 * 60_000);
  bribeAutoDetector.unref();

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

  // Tracker de estratégias (filler) — lido pelo heartbeat (tela "Estratégias" do painel).
  const strategyTracker = new StrategyStatsTracker();

  // ─── Heartbeat (~30s) — snapshot ao vivo pro painel (gauges + estado REAL do toggle) ───
  // O front consome via service_status. autoPaused = execução ARMADA mas travada (toggle OFF).
  const emitHeartbeat = () => {
    const armed = !!arbExec && arbExec.deps.mode !== 'dryrun';
    const live = !!arbExec?.deps.liveExecutionEnabled;
    eventBus.emit({
      type: 'zeus.heartbeat', timestamp: new Date().toISOString(), chain: chainConfig.name,
      mode: arbExec?.deps.mode ?? 'dryrun', severity: 'info', service: 'mis-scanner',
      uptimeSec: Math.floor(process.uptime()),
      adaptiveMinEvUsd: arbExec?.deps.minProfitUsd,
      // Travado por toggle remoto (só quando armado) OU pausado por saúde/reorg (sensores reais).
      autoPaused: (armed ? !live : false) || autoPauseManager.shouldPause(),
      // Razões de pausa de saúde/reorg → tela Saúde do painel (vazio quando saudável).
      cooldowns: autoPauseManager.shouldPause()
        ? [{ label: 'auto-pause', reason: autoPauseManager.summary(), active: true }]
        : [],
      // Latência de dispatch p50/p95 (paridade Motor 1) — omitida enquanto não há amostra real.
      ...(latencyTracker.stats().samples > 0 ? { latency: latencyTracker.stats() } : {}),
      motorStats: [{ tag: 'motor2', ops: mis.stats().totalSamples, netPnl24hUsd: 0 }],
      strategyStats: strategyTracker.snapshot(),
      vettedUniverse: vettingTracker.snapshot(), // porteiro de tokens (tela "Tokens")
      vettingEnforce: { motor2: vettingEnforce.m2 }, // estado do filtro M2 (badge "filtro ligado")
      // Inteligência de gorjeta (Motor 2): mercado + NOSSO lance + estado do auto-liga (nível-feature).
      intel: (() => {
        const mkt = senderRegistry.marketBribeStats();
        const bs = bribeTracker.stats();
        return {
          marketBribeP50Gwei: mkt.p50Gwei,
          marketBribeP75Gwei: mkt.p75Gwei,
          marketBribeP95Gwei: mkt.p95Gwei,
          competitorsActive: mkt.competitorsActive,
          ourBribeGwei: bs?.lastGwei ?? env.GAS_PRIORITY_FEE_GWEI,
          ...(bs?.autoRaised ? { bribeAutoRaised: true, bribeReason: bs.reason } : {}),
          ...(bribeAutoState.enabled
            ? { competitiveBribeAutoEnabled: true, bribeAutoEnableReason: bribeAutoState.reason }
            : {}),
        };
      })(),
      // Fase 2 — ranking de pares com edge persistente (reusa o mesmo mis.ranking() do loop de scan).
      edgePairs: mis.ranking().slice(0, 8).map((r) => ({
        pair: r.groupLabel,
        score: Number((r.score ?? 0).toFixed(2)),
        persistPct: `${(r.persistenceRatio * 100).toFixed(0)}%`,
        avgBps: Math.round(r.avgDivergenceBps ?? 0),
        samples: r.samples,
      })),
    });
  };
  emitHeartbeat();
  const heartbeatTimer = setInterval(emitHeartbeat, env.HEARTBEAT_EVERY_SEC * 1000);
  heartbeatTimer.unref();

  // ─── Controle remoto de execução (toggle do Frontend via Supabase engine_control) ───
  // Só faz sentido quando a execução está ARMADA (mode != dryrun). Em dryrun o toggle é irrelevante
  // (nunca submete de qualquer jeito). Fail-safe: erro/sem-config → mantém TRAVADO.
  const remoteControlActive = !!arbExec && arbExec.deps.mode !== 'dryrun';
  const pollEngineControl = async () => {
    if (!arbExec || arbExec.deps.mode === 'dryrun') return;
    const next = await fetchEngineControlEnabled({
      supabaseUrl: env.SUPABASE_URL,
      supabaseKey: env.SUPABASE_KEY,
      motor: env.ENGINE_CONTROL_MOTOR,
    });
    const prev = !!arbExec.deps.liveExecutionEnabled;
    if (next !== prev) {
      arbExec.deps.liveExecutionEnabled = next; // mesma ref → afeta o gate no dispatchArb
      logger.warn(
        { motor: env.ENGINE_CONTROL_MOTOR, liveExecutionEnabled: next },
        next
          ? '🟢 TOGGLE REMOTO: execução LIGADA — envios passam a ser submetidos (circuit breakers seguem valendo)'
          : '🔴 TOGGLE REMOTO: execução DESLIGADA — envios travados (simula+observa apenas)',
      );
      // O estado REAL é exposto via /readyz (dispatchesPaused) — o Frontend lê de lá pra mostrar
      // estado-desejado vs estado-real. (Heartbeat dedicado fica pro plano da "cola" de webhook.)
    }
  };
  if (remoteControlActive) {
    await pollEngineControl(); // estado inicial no boot (default travado até confirmar)
    logger.info({ motor: env.ENGINE_CONTROL_MOTOR, pollEvery: env.ENGINE_CONTROL_POLL_EVERY }, '🎛️ controle remoto de execução ATIVO (poll via Supabase)');
  }

  // ─── Toggle do FILTRO de tokens M2 (vetting_m2_enforce) — poll AO VIVO, vale mesmo em DRY_RUN ───
  // O env VETTING_M2_ENFORCE é a chave-mestra; o liga/desliga ao vivo é este toggle (botão admin do painel).
  // Fail-safe (fetchEngineControlEnabled): erro/sem-config → false (filtro desligado), igual aos motores.
  const pollVettingEnforce = async () => {
    if (!(env.VETTING_ENABLED && env.VETTING_M2_ENFORCE)) return;
    const next = await fetchEngineControlEnabled({
      supabaseUrl: env.SUPABASE_URL,
      supabaseKey: env.SUPABASE_KEY,
      motor: 'vetting_m2_enforce',
    });
    if (next !== vettingEnforce.m2) {
      vettingEnforce.m2 = next;
      logger.warn(
        { vettingEnforceM2: next },
        next
          ? '🛂 TOGGLE: filtro de tokens M2 LIGADO (gate de execução já respeita; re-filtro do scan no próximo restart/re-vet)'
          : '🛂 TOGGLE: filtro de tokens M2 DESLIGADO',
      );
    }
  };
  if (env.VETTING_ENABLED && env.VETTING_M2_ENFORCE) {
    const vettingTimer = setInterval(() => {
      void pollVettingEnforce();
    }, env.ENGINE_CONTROL_POLL_EVERY * 1000);
    vettingTimer.unref();
  }

  // ─── Filler UniswapX (Motor 2 / F3) — loop próprio (poll→avalia→dispatch). Default OFF. ───
  // DRY_RUN: só observa+loga candidatos. Execução real exige ARB armado+liberado (reusa o toggle motor2)
  // + UNISWAPX_FILLER_ADDRESS. Atômico no contrato (minProfitWei + whitelist + kill switch).
  if (env.UNISWAPX_FILLER_ENABLED && chainConfig.uniswapV3?.quoterV2) {
    const fillerDeps = {
      client,
      quoterAddress: chainConfig.uniswapV3.quoterV2,
      apiBase: env.UNISWAPX_API_BASE,
      chainId: chainConfig.chainId,
      minProfitUsd: env.UNISWAPX_MIN_PROFIT_USD,
      gasCostUsd: env.GAS_COST_USD_ESTIMATE,
      ethUsdPrice: env.ETH_USD_PRICE_ESTIMATE,
      tokenMeta: baseTokenMeta,
      logger,
      nowSec: () => Math.floor(Date.now() / 1000),
      mode: arbExec?.deps.mode ?? 'dryrun',
      wallet: arbExec?.deps.wallet,
      account: arbExec?.deps.account,
      fillerAddress: env.UNISWAPX_FILLER_ADDRESS as Address | undefined,
      profitReceiver: (arbExec?.deps.profitReceiver ?? ZERO) as Address,
      gasOracle: arbExec?.deps.gasOracle,
      liveExecutionEnabled: () => !!arbExec?.deps.liveExecutionEnabled,
      v4QuoteEnabled: env.UNISWAPX_V4_QUOTE_ENABLED,
      strategyTracker,
    };
    logger.info(
      { mode: fillerDeps.mode, filler: fillerDeps.fillerAddress ?? '(ausente → só DRY_RUN)' },
      '🧩 Filler UniswapX ATIVO (Motor 2/F3) — poll de ordens',
    );
    const fillerInterval = setInterval(() => {
      runFillerTick(fillerDeps).catch((err) =>
        logger.warn({ err: err instanceof Error ? err.message : err }, 'filler tick falhou'),
      );
    }, env.UNISWAPX_POLL_INTERVAL_SEC * 1000);
    fillerInterval.unref();
  }

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

      // Reconsulta o toggle remoto a cada N scans (barato; fail-safe interno mantém travado em erro).
      if (remoteControlActive && scanCount % env.ENGINE_CONTROL_POLL_EVERY === 0) {
        await pollEngineControl();
      }
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
            // Gate de execução do filtro M2 (ao vivo): nunca dispara arb em token reprovado no porteiro.
            if (
              vettingEnforce.m2 &&
              (vettingTracker.current(cand.group.tokenA, 'motor2')?.verdict === 'reject' ||
                vettingTracker.current(cand.group.tokenB, 'motor2')?.verdict === 'reject')
            ) {
              logger.debug?.({ par: cand.group.label }, 'arb: token reprovado no porteiro (filtro M2) — pulado');
              continue;
            }
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

      // ─── Visão TRIANGULAR (Parte C) — ciclos A→B→C→A na profundidade (read-only) ───
      // Reusa os spots do scan (sem RPC extra): monta o grafo e acha ciclos lucrativos.
      const triEdges = mis.collectArbEdges(30);
      const cycles = findTriangularCycles(triEdges, { minProfitBps: minDivergenceBps, maxCycles: 10 });
      for (const cyc of cycles) {
        const route = cyc.tokens.map((t) => t.slice(0, 6)).join('→') + '→' + cyc.tokens[0]!.slice(0, 6);
        store.ingest(buildObservationEvent({
          chain: chainConfig.name, category: 'arb_triangular_observed', protocol: 'arb-tri',
          pair: route, profit_delta_bps: cyc.profitBps,
          payload: { profitBps: cyc.profitBps, product: cyc.product, legs: cyc.legs.map((l) => l.poolLabel), tokens: cyc.tokens },
        }));
      }
      if (cycles.length > 0) {
        logger.info(
          { top: cycles.slice(0, 5).map((c) => ({ rota: c.tokens.map((t) => t.slice(0, 6)).join('→'), lucroBps: c.profitBps, pools: c.legs.map((l) => l.poolLabel) })) },
          `🔺 ${cycles.length} ciclo(s) triangular(es) lucrativo(s) na profundidade`,
        );
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
