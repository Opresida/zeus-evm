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
  subscribeWhaleSwaps,
  createDiscordSink,
  createGenericWebhookSink,
  type WhaleSwapDetectedEvent,
} from '@zeus-evm/execution-utils';
import type { Severity } from '@zeus-evm/execution-utils';
import type { Address } from 'viem';

import { loadConfig } from './config';
import { buildChainContext } from './chainContext';
import { logger } from './logger';
import { processWhaleSwap, type BackrunPipelineDeps } from './pipeline';

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

  // Deps comuns pra pipeline
  const deps: BackrunPipelineDeps = {
    env,
    chainCtx,
    mode: env.BACKRUN_MODE,
    eventBus,
    pnlTracker,
    failureTracker,
    gasOracle,
  };

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

main().catch((err) => {
  logger.error({ err }, 'Backrun engine crashed at boot');
  process.exit(1);
});
