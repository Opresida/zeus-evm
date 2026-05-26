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
import { slippageCache } from './slippageCache';
import { PnlTracker } from './pnlTracker';
import { FailureTracker } from './failureTracker';
import { PositionDedupTracker } from './positionDedup';
import { triggerKillSwitchOnChain } from './dispatcher';
import { resolve as resolvePath } from 'node:path';

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
    },
    `🔄 Tick done: aave=${stats.aave} compound=${stats.compound} | dispatched=${stats.dispatched} dryrun=${stats.dryrun} rejected=${stats.rejected} | cache=${cacheStats.hits}/${cacheStats.hits + cacheStats.misses} (${(cacheStats.hitRate * 100).toFixed(0)}%) | PnL24h net=$${pnlStats.netPnlUsd.toFixed(2)} (loss=$${pnlStats.lossesUsd.toFixed(2)}) | fails=${failureStats.consecutiveFailures}/${failureStats.maxAllowed}${failureStats.inCooldown ? ` ⏸️ cd=${Math.ceil(failureStats.cooldownRemainingMs / 1000)}s` : ''} | dedup=${dedupStats.total} (p=${dedupStats.pending} c=${dedupStats.confirmed} f=${dedupStats.failed})`,
  );
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
