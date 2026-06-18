/**
 * ZEUS EVM — Detector entrypoint.
 *
 * Fase 2 — DRY_RUN mode:
 *   1. Conecta na Base via HTTP + WSS
 *   2. A cada novo bloco, escaneia 5 pares alvo
 *   3. Pra cada par, busca oportunidade cross-DEX (UniV3 vs Aerodrome)
 *   4. Filtra por min profit, slippage, gas
 *   5. Loga oportunidades em JSON estruturado (pino)
 *
 * NÃO submete tx. NÃO precisa de private key. Modo observacional puro.
 */

import { createPublicClient, http, parseUnits, type Address, type PublicClient } from 'viem';
import { base } from 'viem/chains';

import { BASE_MAINNET, getTargetPairsForChain, type TargetPair } from '@zeus-evm/chain-config';
import {
  findCrossDexArb,
  filterOpportunity,
  buildArbitrageCalldata,
  simulateArbitrage,
  type CrossDexOpportunity,
  type FilterCriteria,
} from '@zeus-evm/strategy';
import {
  TimeseriesStore,
  buildObservationEvent,
  resolveIntelligenceDbPath,
  MetricRegistry,
  registerStandardMetrics,
  DimensionMetricsExporter,
  startHealthServer,
} from '@zeus-evm/execution-utils';
import { subscribeToBlocks } from './mempool/blockSubscription';
import { loadConfig } from './config';
import { logger } from './logger';

type AnyPublicClient = PublicClient<any, any>;

// ─── Tamanho de teste por par (em USD aproximado) ───
// Pra Fase 2 DRY_RUN, testamos com $1.000 por par — size suficiente pra ter
// oportunidades não-triviais sem gastar todas as quotes em chamadas pequenas.
const TEST_AMOUNT_USD = 1_000;

/**
 * Calcula amountIn em wei do tokenA equivalente a TEST_AMOUNT_USD.
 */
function getAmountInForPair(pair: TargetPair): bigint {
  const amountInTokens = TEST_AMOUNT_USD / pair.estimatedUsdValueA;
  return parseUnits(amountInTokens.toFixed(Math.min(pair.decimalsA, 18)), pair.decimalsA);
}

/**
 * Critérios base de filtragem (maxTradeWei adicionado por par).
 */
function buildFilterCriteria(minProfitUsd: number, maxSlippageBps: number): Omit<FilterCriteria, 'maxTradeWei'> {
  return {
    minProfitUsd,
    maxSlippageBps,
    estimatedGasUsd: 0.5,  // Base é cheap (~$0.10-1.00 por tx)
    flashloanFeeBps: 0,    // Modalidade wallet por enquanto. 5 quando ativar flashloan
  };
}

/** Config opcional pra simulação on-chain após filter pass. */
interface SimulationContext {
  executorAddress: Address;
  callerAddress: Address;
  slippageBps: number;
}

/**
 * Após oportunidade passar nos filtros, encoda calldata e simula via eth_call.
 * Logs sucesso (com gasUsed) ou revert (com reason decodificada).
 */
async function simulateFilteredOpportunity(
  client: AnyPublicClient,
  opp: CrossDexOpportunity,
  blockNumber: bigint,
  sim: SimulationContext,
): Promise<void> {
  try {
    const calldata = buildArbitrageCalldata({
      opp,
      profitReceiver: sim.callerAddress,
      slippageBps: sim.slippageBps,
    });

    const result = await simulateArbitrage({
      client,
      executorAddress: sim.executorAddress,
      callerAddress: sim.callerAddress,
      calldata,
      blockNumber,
    });

    if (result.success) {
      logger.info(
        {
          event: 'simulation_success',
          pair: opp.pair.id,
          gasUsed: result.gasUsed?.toString(),
          blockNumber: blockNumber.toString(),
        },
        `🟢 SIM OK: ${opp.pair.id} gas=${result.gasUsed}`,
      );
    } else {
      logger.warn(
        {
          event: 'simulation_revert',
          pair: opp.pair.id,
          revertReason: result.revertReason,
          blockNumber: blockNumber.toString(),
        },
        `🔴 SIM REVERT: ${opp.pair.id} → ${result.revertReason}`,
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, pair: opp.pair.id },
      'simulação falhou inesperadamente',
    );
  }
}

/**
 * Scan completo: itera 5 pares, busca arb, aplica filtros, loga.
 */
async function scanPairs(
  client: AnyPublicClient,
  blockNumber: bigint,
  filterCriteria: Omit<FilterCriteria, 'maxTradeWei'>,
  simContext: SimulationContext | undefined,
  store: TimeseriesStore | undefined,
  pairs: readonly TargetPair[],
): Promise<{ scanned: number; detected: number; filtered: number; simulated: number }> {
  let detected = 0;
  let filtered = 0;
  let simulated = 0;

  for (const pair of pairs) {
    const amountInA = getAmountInForPair(pair);
    const maxTradeWei = amountInA * 10n; // cap em 10x o amount testado

    try {
      const opp = await findCrossDexArb({
        client,
        pair,
        amountInA,
        blockNumber,
      });

      if (!opp) continue;
      detected++;

      const result = filterOpportunity(opp, { ...filterCriteria, maxTradeWei });

      if (result.passed) {
        filtered++;
        logger.info(
          {
            event: 'opportunity_filtered',
            pair: pair.id,
            buy: opp.buyQuote.source,
            sell: opp.sellQuote.source,
            amountIn: opp.amountIn.toString(),
            profitWei: opp.profitWei.toString(),
            profitBps: opp.profitBps,
            profitUsd: opp.profitUsd.toFixed(4),
            netProfitUsd: result.netProfitUsd?.toFixed(4),
            blockNumber: blockNumber.toString(),
          },
          `💰 OPORTUNIDADE: ${pair.id} buy@${opp.buyQuote.source} sell@${opp.sellQuote.source} +$${result.netProfitUsd?.toFixed(2)}`,
        );

        // OIE — grava a oportunidade observada no ledger (DuckDB) pra ranking empírico de pares.
        if (store) {
          store.ingest(
            buildObservationEvent({
              chain: BASE_MAINNET.name,
              category: 'arb_observed',
              protocol: 'arb',
              pair: pair.id,
              amount_usd: TEST_AMOUNT_USD,
              profit_usd: opp.profitUsd,
              gas_usd: filterCriteria.estimatedGasUsd,
              payload: {
                buyVenue: opp.buyQuote.source,
                sellVenue: opp.sellQuote.source,
                profitBps: opp.profitBps,
                netProfitUsd: result.netProfitUsd,
                blockNumber: blockNumber.toString(),
              },
            }),
          );
        }

        if (simContext) {
          simulated++;
          await simulateFilteredOpportunity(client, opp, blockNumber, simContext);
        }
      } else {
        logger.debug(
          {
            event: 'opportunity_rejected',
            pair: pair.id,
            profitBps: opp.profitBps,
            profitUsd: opp.profitUsd.toFixed(4),
            reason: result.reason,
          },
          `rejeitada: ${pair.id} (${result.reason})`,
        );
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, pair: pair.id }, 'scan pair failed');
    }
  }

  return { scanned: pairs.length, detected, filtered, simulated };
}

async function main() {
  const env = loadConfig();

  // Varredura dinâmica: curados (target-pairs.ts) + auto-targets do discovery-scraper.
  // Sem arquivo auto-targets, cai nos curados (comportamento idêntico ao anterior).
  // Resolvido 1x no boot — restart pega novos auto-targets gerados pelo scraper.
  const targetPairs = getTargetPairsForChain(BASE_MAINNET.chainId);

  logger.info(
    {
      chain: BASE_MAINNET.name,
      chainId: BASE_MAINNET.chainId,
      targetPairs: targetPairs.length,
      mode: 'DRY_RUN',
    },
    '🚀 Detector boot',
  );

  if (env.KILL_SWITCH) {
    logger.warn('KILL_SWITCH ativo — bot NÃO submeterá transações (esperado em Fase 2)');
  }

  // ─── Setup client HTTP ───
  const publicClient: AnyPublicClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_HTTP),
  });

  const blockNumber = await publicClient.getBlockNumber();
  logger.info({ blockNumber: blockNumber.toString() }, '✅ Conectado em Base mainnet');

  // ─── Ledger OIE (DuckDB) — grava oportunidades observadas pro ranking empírico de pares ───
  // Path via INTELLIGENCE_DB_PATH (volume persistente na Fly.io) ou logs/ local.
  const store = new TimeseriesStore({
    dbPath: resolveIntelligenceDbPath('intelligence-detector.duckdb'),
    logger,
  });
  await store.init();

  // ─── Observabilidade (OIE Etapa D): bridge ledger → Prometheus + /metrics pro Grafana ───
  const metricRegistry = new MetricRegistry({ logger });
  registerStandardMetrics(metricRegistry);
  const metricsExporter = new DimensionMetricsExporter({
    registry: metricRegistry,
    store,
    chain: BASE_MAINNET.name,
    windowMs: env.METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    logger,
  });
  metricsExporter.start();

  const healthServer = env.HEALTH_SERVER_ENABLED
    ? startHealthServer({
        serviceName: 'detector',
        port: env.HEALTH_SERVER_PORT,
        host: env.HEALTH_SERVER_HOST,
        version: 'dryrun',
        readinessProvider: () => ({ status: 'ok', checks: {}, dispatchesPaused: false, pausedReasons: [] }),
        metricsProvider: () => metricRegistry.render(),
        logger,
      })
    : undefined;

  // Graceful shutdown: para o exporter/health server e drena o buffer do DuckDB.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    metricsExporter.stop();
    healthServer?.close();
    await store.shutdown();
    logger.info('💾 ledger drenado — detector encerrado');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const filterCriteria = buildFilterCriteria(env.MIN_PROFIT_USD, env.MAX_SLIPPAGE_BPS);

  // ─── Simulação on-chain (opcional) ───
  // Se EXECUTOR_ADDRESS + EXECUTOR_OWNER_ADDRESS estiverem setados, simula via eth_call
  // após cada oportunidade passar nos filtros. Não submete tx — apenas valida custom errors
  // e estima gas. Fase 3 = simulação only; submissão real entra na Fase 5+.
  // Aceita EXECUTOR_CONTRACT_ADDRESS (preferido) com fallback pro legado EXECUTOR_ADDRESS
  const contractAddress = env.EXECUTOR_CONTRACT_ADDRESS ?? env.EXECUTOR_ADDRESS;
  const callerAddress = env.EXECUTOR_BOT_ADDRESS ?? env.EXECUTOR_OWNER_ADDRESS;

  let simContext: SimulationContext | undefined;
  if (contractAddress && callerAddress) {
    simContext = {
      executorAddress: contractAddress as Address,
      callerAddress: callerAddress as Address,
      slippageBps: env.MAX_SLIPPAGE_BPS,
    };
    logger.info(
      {
        contract: simContext.executorAddress,
        caller: simContext.callerAddress,
        slippageBps: simContext.slippageBps,
      },
      '🧪 Simulação on-chain ATIVA (eth_call) — não submete tx',
    );
  } else {
    logger.info(
      'EXECUTOR_CONTRACT_ADDRESS / EXECUTOR_BOT_ADDRESS não setados — pulando simulação on-chain',
    );
  }

  // ─── Scan inicial ───
  logger.info(`Executando scan inicial em ${targetPairs.length} pares alvo...`);
  const initial = await scanPairs(publicClient, blockNumber, filterCriteria, simContext, store, targetPairs);
  logger.info(
    { ...initial, blockNumber: blockNumber.toString() },
    `✅ Scan inicial: ${initial.scanned} pares, ${initial.detected} brutas, ${initial.filtered} filtradas, ${initial.simulated} simuladas`,
  );

  // ─── Subscribe a novos blocos ───
  if (!env.BASE_RPC_WS) {
    logger.warn('BASE_RPC_WS não configurado — rodando em polling. Definir .env pra subscribe via WSS.');
    setInterval(async () => {
      try {
        const block = await publicClient.getBlockNumber();
        const stats = await scanPairs(publicClient, block, filterCriteria, simContext, store, targetPairs);
        if (stats.detected > 0) {
          logger.info({ ...stats, blockNumber: block.toString() }, `[poll] scan`);
        }
      } catch (err) {
        logger.error({ err }, 'polling iteration failed');
      }
    }, 5_000);
  } else {
    subscribeToBlocks({
      wsUrl: env.BASE_RPC_WS,
      onBlock: async (block) => {
        const stats = await scanPairs(publicClient, block, filterCriteria, simContext, store, targetPairs);
        if (stats.detected > 0 || stats.filtered > 0) {
          logger.info({ ...stats, blockNumber: block.toString() }, `[block ${block}] scan`);
        }
      },
    });
  }

  await new Promise(() => {});
}

main().catch((err) => {
  logger.error({ err }, 'Detector crashed at boot');
  process.exit(1);
});
