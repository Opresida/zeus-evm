/**
 * Smoke test do backrun-engine — valida pipeline com whale sintético sem precisar
 * de mempool real. Útil pra:
 *   - Confirmar que typecheck + wiring funciona
 *   - Validar que processWhaleSwap chega até validateBackrunProfit (que vai
 *     reverter ou passar dependendo do estado on-chain real)
 *
 * Roda em DRY_RUN sempre — nunca submete tx.
 */

import {
  EventBus,
  PnlTracker,
  FailureTracker,
  GasOracle,
  emitSyntheticWhale,
} from '@zeus-evm/execution-utils';
import { getTargetPairsForChain } from '@zeus-evm/chain-config';

import { loadConfig } from './config';
import { buildChainContext } from './chainContext';
import { logger } from './logger';
import { processWhaleSwap, type BackrunPipelineDeps } from './pipeline';
import type { WhaleSwap } from '@zeus-evm/strategy';

async function main() {
  const env = loadConfig();
  // Força dryrun pra smoke
  (env as any).BACKRUN_MODE = 'dryrun';
  const chainCtx = buildChainContext(env);

  logger.info(
    { chain: chainCtx.chainName },
    `🧪 Smoke backrun-engine — DRY_RUN mode`,
  );

  const eventBus = new EventBus();
  const pnlTracker = new PnlTracker({
    dailyLossLimitUsd: env.DAILY_LOSS_LIMIT_USD,
    logFilePath: env.PNL_LOG_FILE,
    logger,
    autoKillEnabled: false,
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

  const deps: BackrunPipelineDeps = {
    env,
    chainCtx,
    mode: 'dryrun',
    eventBus,
    pnlTracker,
    failureTracker,
    gasOracle,
  };

  // Subscriber pra log dos eventos emitidos
  eventBus.subscribe(async (event) => {
    if (event.type === 'whale.swap_detected') {
      logger.info({ pendingTxHash: event.pendingTxHash, venue: event.venue }, '🐋 evento: whale detected');
    } else if (event.type === 'backrun.opportunity_found') {
      logger.info({ pairId: event.pairId, profit: event.expectedProfitUsd }, '🎯 evento: opportunity');
    } else if (event.type === 'backrun.dispatched') {
      logger.info({ pairId: event.pairId }, '⚡ evento: dispatched (dryrun)');
    } else if (event.type === 'backrun.rejected') {
      logger.info({ stage: event.stage, reason: event.reason }, '⏭️ evento: rejected');
    }
  });

  // Constrói whale sintético usando primeiro par disponível na chain ativa
  const chainPairs = getTargetPairsForChain(chainCtx.chainId);
  const firstPair = chainPairs[0];
  if (!firstPair) {
    throw new Error(`Nenhum target pair configurado pra chainId=${chainCtx.chainId}`);
  }

  const syntheticWhale: WhaleSwap = {
    pendingTxHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    venue: 'aerodrome', // Aerodrome em Base, Velodrome em OP — mesmo decoder
    router: chainCtx.velodromeStyleRouter,
    tokenIn: firstPair.tokenB, // stable/WETH
    tokenOut: firstPair.tokenA, // volatile (AERO em Base, VELO em OP)
    amountIn: 100_000n * 10n ** BigInt(firstPair.decimalsB),
    amountInUsd: 100_000,
    sender: null,
    tokenInDecimals: firstPair.decimalsB,
    tokenOutDecimals: firstPair.decimalsA,
    tokenInSymbol: firstPair.id.split('/')[1] ?? '?',
    tokenOutSymbol: firstPair.id.split('/')[0] ?? '?',
    observedAtBlock: 0n,
    detectedAt: Date.now(),
  };

  logger.info(
    {
      pair: firstPair.id,
      venue: syntheticWhale.venue,
      amountInUsd: syntheticWhale.amountInUsd,
      chain: chainCtx.chainName,
    },
    `🧪 Enviando whale sintético — $${syntheticWhale.amountInUsd} swap em ${firstPair.id} (${chainCtx.chainName})`,
  );

  // Emite no bus (sinks formatariam Discord embed) E chama direct (rota direta pro pipeline)
  emitSyntheticWhale(eventBus, syntheticWhale, chainCtx.chainName, 'dryrun');
  const result = await processWhaleSwap(syntheticWhale, deps);

  logger.info({ result }, `✅ Smoke completed — status=${result.status}`);
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'Smoke failed');
  process.exit(1);
});
