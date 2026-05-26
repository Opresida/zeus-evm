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
import { BASE_TARGET_PAIRS } from '@zeus-evm/chain-config';

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

  // Constrói whale sintético usando AERO/USDC (par estrela)
  const aeroUsdc = BASE_TARGET_PAIRS.find((p) => p.id === 'AERO/USDC');
  if (!aeroUsdc) {
    throw new Error('TargetPair AERO/USDC não encontrado em BASE_TARGET_PAIRS');
  }

  const syntheticWhale: WhaleSwap = {
    pendingTxHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    venue: 'aerodrome',
    router: chainCtx.aerodromeRouter,
    tokenIn: aeroUsdc.tokenB, // USDC
    tokenOut: aeroUsdc.tokenA, // AERO
    amountIn: 100_000n * 10n ** BigInt(aeroUsdc.decimalsB), // $100k USDC
    amountInUsd: 100_000,
    sender: null,
    tokenInDecimals: aeroUsdc.decimalsB,
    tokenOutDecimals: aeroUsdc.decimalsA,
    tokenInSymbol: 'USDC',
    tokenOutSymbol: 'AERO',
    observedAtBlock: 0n,
    detectedAt: Date.now(),
  };

  logger.info(
    {
      pair: aeroUsdc.id,
      venue: syntheticWhale.venue,
      amountInUsd: syntheticWhale.amountInUsd,
    },
    `🧪 Enviando whale sintético — $${syntheticWhale.amountInUsd} swap em ${aeroUsdc.id}`,
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
