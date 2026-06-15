/**
 * Pipeline orchestrator — costura calculator → simulator → builder → dispatcher.
 *
 * Fluxo pra cada `AaveLiquidatablePosition`:
 *   1. Calculator: acha flashloan ótimo + profit esperado. Descarta se < threshold.
 *   2. Builder: monta calldata `executeLiquidation`.
 *   3. Simulator: eth_call valida (sem gastar gas). Aborta se reverte.
 *   4. Dispatcher: dryrun loga / testnet+mainnet submete.
 *
 * Retorna `DispatchOutcome` com status final pra que o caller decida o que fazer.
 */

import type { Address } from 'viem';

import { logger } from './logger';
import type { LiquidatorEnv } from './config';
import type { LiquidatorChainContext } from './chainContext';
import type {
  AaveLiquidatablePosition,
  CompoundLiquidatablePosition,
  MorphoLiquidatablePosition,
  MoonwellLiquidatablePosition,
  DispatchOutcome,
} from './types';
import type { BribeConfig } from '@zeus-evm/strategy';
import { calculateOptimalLiquidation } from './protocols/aave/calculator';
import { AavePriceOracle } from './protocols/aave/oracle';
import { buildLiquidationTx } from './protocols/aave/builder';
import { simulateLiquidation } from './protocols/aave/simulator';
import { calculateOptimalCompoundLiquidation } from './protocols/compound/calculator';
import { buildCompoundLiquidationTx } from './protocols/compound/builder';
import { simulateCompoundLiquidation } from './protocols/compound/simulator';
import { calculateOptimalMorphoLiquidation } from './protocols/morpho/calculator';
import { buildMorphoLiquidationTx } from './protocols/morpho/builder';
import { simulateMorphoLiquidation } from './protocols/morpho/simulator';
import { isLiquidatable as isMorphoLiquidatable } from './protocols/morpho/math';
import { calculateOptimalMoonwellLiquidation } from './protocols/moonwell/calculator';
import { buildMoonwellLiquidationTx } from './protocols/moonwell/builder';
import { simulateMoonwellLiquidation } from './protocols/moonwell/simulator';
import { selectFlashSource } from './flashSourceSelector';
import { dispatch, triggerKillSwitchOnChain } from './dispatcher';
import {
  aavePositionKey,
  compoundPositionKey,
  morphoPositionKey,
  computeBribeSlippageFloor,
  scoreLiquidationOpportunity,
  ChainlinkStalenessChecker,
  PauseDetector,
  type PnlTracker,
  type FailureTracker,
  type PositionDedupTracker,
  type GasReserveTracker,
  type EventBus,
  type PnlReconciler,
  type FailureCollector,
} from '@zeus-evm/execution-utils';
import { isAaveStillLiquidatable, isCompoundStillLiquidatable } from './staleCheck';

export interface PipelineDeps {
  env: LiquidatorEnv;
  ctx: LiquidatorChainContext;
  /** Caller pra eth_call/sendTx — em dryrun usa zero address; em real usa bot wallet. */
  callerAddress: Address;
  /** Cap on-chain via getMaxTradeFor(debtAsset). Computado uma vez no boot e cached. */
  contractCapByDebtAsset: Map<string, bigint>;
  /** PnL tracker — registra wins/losses + aciona kill switch automático. */
  pnlTracker?: PnlTracker;
  /** Failure tracker — pausa bot após N falhas consecutivas. */
  failureTracker?: FailureTracker;
  /** Dedup tracker — evita re-submeter mesma position em ticks consecutivos. */
  dedupTracker?: PositionDedupTracker;
  /** Gas reserve tracker — bloqueia dispatch se balance < critical. */
  gasReserveTracker?: GasReserveTracker;
  /** Event bus pra emitir eventos tipados (webhook/alerts). */
  eventBus?: EventBus;
  /** Gas oracle EIP-1559 pra pricing correto on Base/Arb/OP. */
  gasOracle?: import('@zeus-evm/execution-utils').GasOracle;
  /** Aave V3 PriceOracle — usado pra conversões USD-corretas no calculator. */
  aaveOracle: AavePriceOracle;
  /** PnL Reconciler (Item 10) — gera análise rica expected vs realized. */
  pnlReconciler?: PnlReconciler;
  /** Failure Collector (Item 4) — schema rico pra failures persistidos JSONL. */
  failureCollector?: FailureCollector;
  /** AutoPauseManager (Item 12 H10) — gate pré-dispatch agregado. */
  autoPauseManager?: import('@zeus-evm/execution-utils').AutoPauseManager;
  /** Tracer (Item 16B OB1) — spans pra correlação. */
  tracer?: import('@zeus-evm/execution-utils').Tracer;
  /** Chainlink staleness checker (Grupo B) — gate pre-dispatch contra oracle stale. */
  stalenessChecker?: ChainlinkStalenessChecker;
  /** Pause detector (Grupo B) — gate pre-dispatch contra protocol pausado upstream. */
  pauseDetector?: PauseDetector;
  /**
   * Mercado Aave ativo (Doutrina multi-market). Quando presente, sobrescreve
   * os endereços core do chainConfig.aave — permite operar Seamless e outros
   * forks com o MESMO pipeline. Ausente = Aave V3 core (compat).
   */
  aaveMarket?: { label: string; pool: Address; oracleAddress: Address };
  /** Endereço do ZeusMoonwellLiquidator (contrato SEPARADO). Necessário pro pipeline Moonwell. */
  moonwellLiquidatorAddress?: Address;
}

/**
 * Multi-hop intermediates (Grupo B) — tokens "ponte" pra rotear collateral→debt
 * via pools mais profundos. Lê dinâmicamente do chain-config pra ser multi-chain.
 *
 * Base/Arb/OP: WETH + USDC | Polygon: WMATIC + USDC | Avalanche: WAVAX + USDC
 */
function buildMultiHopIntermediates(chainConfig: LiquidatorChainContext['chainConfig']): Address[] {
  const candidates: (Address | undefined)[] = [
    chainConfig.tokens['WETH'],
    chainConfig.tokens['WMATIC'],
    chainConfig.tokens['WAVAX'],
    chainConfig.tokens['USDC'],
    chainConfig.tokens['USDbC'],
  ];
  return candidates.filter((t): t is Address => !!t);
}

/**
 * Constrói BribeConfig com `minBribeWei` calculado off-chain pra proteger contra
 * sandwich do swap inline UniV3 da BribeManager (Audit Pass 4 H-01).
 *
 * Quando `BRIBE_ENABLED=false` ou profit < threshold → retorna undefined (sem bribe).
 * Quando profitToken == WETH → minBribeWei = 0 (fast path não faz swap).
 * Quando profitToken != WETH → quote profitToken→WETH e seta floor = quote × (1 − slippage).
 * Se quote falha (sem liquidez no pool) → loga warn e retorna undefined (submete sem bribe
 * em vez de submeter inseguro com minBribeWei=0).
 *
 * Pra MVP do liquidator, usa BPS fixo (default 50%). Tabela escalonada por
 * gas war fica no backrun-engine onde a competição é mais brutal.
 */
async function buildBribeWithSlippageFloor(
  env: LiquidatorEnv,
  ctx: LiquidatorChainContext,
  profitToken: Address,
  profitTokenDecimals: number,
  expectedProfitWei: bigint,
  profitUsd: number,
): Promise<BribeConfig | undefined> {
  if (!env.BRIBE_ENABLED) return undefined;
  if (profitUsd < env.BRIBE_MIN_PROFIT_USD) return undefined;

  const bribeBps = BigInt(env.BRIBE_DEFAULT_BPS);
  const swapSlippageBps = BigInt(env.BRIBE_SWAP_SLIPPAGE_BPS);

  const quoterAddress = ctx.chainConfig.uniswapV3?.quoterV2;
  const wethAddress = ctx.chainConfig.tokens.WETH;
  if (!quoterAddress || !wethAddress) {
    logger.warn(
      { chain: ctx.chainConfig.name },
      '⚠️  Bribe: sem quoter ou WETH na chainConfig — submetendo sem bribe',
    );
    return undefined;
  }

  const floor = await computeBribeSlippageFloor({
    client: ctx.client,
    quoterAddress,
    weth: wethAddress,
    profitToken,
    profitTokenDecimals,
    expectedProfitWei,
    bribeBps,
    swapFeeTier: env.BRIBE_SWAP_FEE_TIER,
    slippageBps: swapSlippageBps,
  });

  if (!floor.ok) {
    logger.warn(
      { profitToken, reason: floor.reason },
      `⚠️  Bribe slippage floor falhou (${floor.reason}) — submetendo sem bribe`,
    );
    return undefined;
  }

  return {
    bribeBps,
    minBribeWei: floor.minBribeWei,
    bribeMaxBps: BigInt(env.BRIBE_HARD_CAP_BPS),
    swapFeeTier: env.BRIBE_SWAP_FEE_TIER,
    swapSlippageBps,
  };
}

/**
 * OIE Etapa B — gate de edge ciente de OEV (prioriza Morpho).
 *
 * Pontua a liquidação pelo lucro REALISTA pós-OEV (Aave/Compound/Moonwell na Base têm
 * OEV capture ~80-99% via SVR/MEV tax; Morpho segue aberto). Ver
 * docs/refs/competitive-landscape.md.
 *
 * - SEMPRE loga o score (observabilidade) — o operador enxerga quais protocolos viraram
 *   antieconômicos pós-OEV mesmo com o gate desligado.
 * - Quando `MIN_OPPORTUNITY_EV_USD` está setado (opt-in), descarta a liquidação cujo EV
 *   ajustado a OEV fica abaixo do mínimo → o bot foca em Morpho naturalmente.
 *
 * Default (env ausente) = comportamento inalterado (só loga).
 */
function liquidationEdgeGate(
  protocol: string,
  decision: { expectedProfitUsd: number; estimatedSlippageBps?: number },
  deps: PipelineDeps,
  borrower: string,
): { skip: true; reason: string } | { skip: false } {
  const env = deps.env;
  const score = scoreLiquidationOpportunity({
    profitUsd: decision.expectedProfitUsd,
    gasUsd: env.GAS_COST_USD_ESTIMATE,
    slippageBps: decision.estimatedSlippageBps ?? 0,
    protocol,
    opportunityId: borrower,
  });

  logger.debug(
    {
      protocol,
      borrower,
      profitUsdNominal: decision.expectedProfitUsd.toFixed(2),
      oevRecapturePct: Math.round(score.oevRecapture * 100),
      edgeAdjustedProfitUsd: score.edgeAdjustedProfitUsd.toFixed(2),
      evUsd: score.evUsd.toFixed(2),
      score: score.score,
    },
    `🧮 OIE liquidation score (${protocol}): nominal $${decision.expectedProfitUsd.toFixed(2)} → pós-OEV $${score.edgeAdjustedProfitUsd.toFixed(2)} (recapture ${Math.round(score.oevRecapture * 100)}%)`,
  );

  if (env.MIN_OPPORTUNITY_EV_USD != null && score.evUsd < env.MIN_OPPORTUNITY_EV_USD) {
    return {
      skip: true,
      reason: `OIE edge gate: EV pós-OEV $${score.evUsd.toFixed(2)} < min $${env.MIN_OPPORTUNITY_EV_USD.toFixed(2)} (recapture=${Math.round(score.oevRecapture * 100)}% protocol=${protocol})`,
    };
  }
  return { skip: false };
}

export async function runAavePipeline(
  position: AaveLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  // Tracing: encapsula execução num span (Item 16B OB1). No-op se tracer ausente.
  if (deps.tracer) {
    return deps.tracer.runInSpan(
      'liquidator.runAavePipeline',
      async (span) => {
        span.setAttributes({
          chain: deps.ctx.chainConfig.name,
          borrower: position.borrower,
          protocol: 'aave-v3',
          debt_asset: position.debtAssetSymbol,
          collateral_asset: position.collateralAssetSymbol,
        });
        const result = await _runAavePipelineInner(position, deps);
        span.setAttribute('outcome', result.status);
        if (result.status === 'reverted_pre_dispatch' || result.status === 'reverted_on_chain') {
          span.setAttribute('reject_reason', (result as { reason?: string }).reason ?? '');
        }
        return result;
      },
    );
  }
  return _runAavePipelineInner(position, deps);
}

async function _runAavePipelineInner(
  position: AaveLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  const { env, ctx, callerAddress, contractCapByDebtAsset, pnlTracker, failureTracker, dedupTracker, gasReserveTracker } = deps;

  // Mercado Aave ativo (core ou fork como Seamless). Doutrina multi-market.
  const marketLabel = deps.aaveMarket?.label ?? 'aave-v3';
  const marketPool = deps.aaveMarket?.pool ?? ctx.chainConfig.aave.pool;
  const marketOracle = deps.aaveMarket?.oracleAddress ?? ctx.chainConfig.aave.oracle;

  // Gate kill switch
  if (pnlTracker?.isKillSwitchTriggered()) {
    return {
      status: 'reverted_pre_dispatch',
      reason: `kill switch active: ${pnlTracker.killReason() ?? 'unknown'}`,
    };
  }

  // Gate cooldown
  if (failureTracker?.inCooldown()) {
    const remainingS = Math.ceil(failureTracker.remainingCooldownMs() / 1000);
    return {
      status: 'reverted_pre_dispatch',
      reason: `cooldown ativo, retomada em ${remainingS}s`,
    };
  }

  // Gate gas reserve crítico
  if (gasReserveTracker?.shouldBlockDispatch()) {
    return {
      status: 'reverted_pre_dispatch',
      reason: `gas reserve critical (balance=${gasReserveTracker.stats().balanceEth} ETH)`,
    };
  }

  // Gate AutoPauseManager (Item 12 H10) — agrega sinais de health (staleness, process, reorg, etc)
  if (deps.autoPauseManager?.shouldPause()) {
    return {
      status: 'reverted_pre_dispatch',
      reason: `auto-pause active: ${deps.autoPauseManager.summary()}`,
    };
  }

  // Gate oracle staleness (Grupo B) — Chainlink updatedAt > threshold = abort
  if (deps.stalenessChecker) {
    const stale = await deps.stalenessChecker.checkAaveAssetsStaleness(
      marketOracle,
      [position.debtAsset, position.collateralAsset],
    );
    for (const [asset, result] of stale.entries()) {
      if (result.status === 'stale' || result.status === 'invalid') {
        logger.warn(
          { asset, status: result.status, age: result.age_seconds, threshold: result.threshold_seconds, reason: result.reason },
          `⏰ Oracle staleness gate: ${result.status}`,
        );
        return {
          status: 'reverted_pre_dispatch',
          reason: `oracle ${result.status} for ${asset} (age=${result.age_seconds}s, threshold=${result.threshold_seconds}s)`,
        };
      }
    }
  }

  // Gate pause detection upstream (Grupo B) — protocol pausado = abort
  if (deps.pauseDetector) {
    const pause = await deps.pauseDetector.checkAaveLiquidation(
      marketPool,
      position.debtAsset,
      position.collateralAsset,
    );
    if (pause.paused) {
      logger.warn(
        { market: marketLabel, reason: pause.reason, block: pause.checked_at_block.toString() },
        `⏸️  Aave pause gate (${marketLabel}): ${pause.reason}`,
      );
      return {
        status: 'reverted_pre_dispatch',
        reason: `aave paused: ${pause.reason}`,
      };
    }
  }

  // Gate dedup (key inclui market label pra não colidir entre Aave core e forks)
  const positionKey = aavePositionKey(ctx.chainConfig.name, position.borrower, marketLabel);
  if (dedupTracker) {
    const dedupCheck = dedupTracker.check(positionKey);
    if (dedupCheck.blocked) {
      return {
        status: 'reverted_pre_dispatch',
        reason: `dedup blocked: ${dedupCheck.status} há ${Math.round(dedupCheck.ageMs / 1000)}s`,
      };
    }
  }

  // Sanity: chain tem QuoterV2 UniV3 (calculator não funciona sem isso)
  if (!ctx.chainConfig.uniswapV3?.quoterV2) {
    return { status: 'reverted_pre_dispatch', reason: 'no UniswapV3 QuoterV2 configured' };
  }

  // 1. Calculator — roda SEMPRE, mesmo sem executor deployado.
  // Em DRY_RUN sem executor, queremos LOGAR a decision teórica (profit/slippage estimado)
  // pra calibração das 2 semanas de observação.
  // B-5 fix: cap deve estar cacheado no boot. Sem cap em modo real é config error.
  // Calculator já tem scaleToSafeRange pra lidar com BigInts gigantes via shift bits.
  let cap = contractCapByDebtAsset.get(position.debtAsset.toLowerCase());
  if (!cap) {
    if (env.LIQUIDATOR_MODE !== 'dryrun') {
      logger.error(
        { debtAsset: position.debtAsset, mode: env.LIQUIDATOR_MODE },
        '🛑 contractCap não cacheado pra debt asset — bloqueando dispatch (boot bug)',
      );
      return { status: 'reverted_pre_dispatch', reason: 'contractCap missing for debt asset' };
    }
    // Em dryrun, fallback conservador de $1M em wei do debt asset (assume stable peg
    // como APROXIMAÇÃO — só pra logar decisão teórica).
    cap = 1_000_000n * 10n ** BigInt(position.debtAssetDecimals);
  }
  const outcome = await calculateOptimalLiquidation(position, {
    env,
    client: ctx.client,
    quoterAddress: ctx.chainConfig.uniswapV3.quoterV2,
    contractCapWei: cap,
    oracle: deps.aaveOracle,
    multiHopIntermediates: env.MULTI_HOP_SWAPS_ENABLED
      ? buildMultiHopIntermediates(ctx.chainConfig)
      : undefined,
  });

  if (!outcome.ok) {
    logger.debug(
      { borrower: position.borrower, reason: outcome.reason },
      `⏭️  Descartado pre-build: ${outcome.reason}`,
    );
    return { status: 'reverted_pre_dispatch', reason: outcome.reason };
  }

  const decision = outcome.decision;

  // OIE Etapa B — gate de edge ciente de OEV (prioriza Morpho; opt-in via MIN_OPPORTUNITY_EV_USD)
  const aaveEdge = liquidationEdgeGate(marketLabel, decision, deps, position.borrower);
  if (aaveEdge.skip) {
    logger.info({ borrower: position.borrower, reason: aaveEdge.reason }, `⏭️  ${aaveEdge.reason}`);
    return { status: 'reverted_pre_dispatch', reason: aaveEdge.reason };
  }

  // Gate executor: sem executor deployado, marca como dryrun_skipped
  // (decision foi calculada e LOGADA pelo calculator — alimenta cache + calibração)
  if (!ctx.executorContractAddress) {
    logger.info(
      {
        chain: ctx.chainConfig.name,
        borrower: position.borrower,
        wouldFlashloanWei: decision.flashloanAmount.toString(),
        wouldProfitUsd: decision.expectedProfitUsd.toFixed(2),
        slippageBps: decision.estimatedSlippageBps,
      },
      `🔭 [no-executor] Aave decision LOGADA mas não dispatcheada — sem contrato em ${ctx.chainConfig.name}`,
    );
    return { status: 'dryrun_skipped', reason: 'no executor deployed on chain' };
  }

  // 2. Builder — opt-in pra bribe via env (v7)
  // minBribeWei calculado off-chain via Quoter (proteção sandwich pós H-01)
  const aaveBribe = await buildBribeWithSlippageFloor(
    env,
    ctx,
    position.debtAsset as Address,
    position.debtAssetDecimals,
    decision.expectedProfitWei,
    decision.expectedProfitUsd,
  );
  // Seletor de fonte de flashloan: Morpho/Balancer (0%) se houver liquidez, senão Aave (0,05%).
  // Sobrescreve a decision; o profit math dos calculators permanece conservador a 0,05%
  // (o ganho de 5bps é capturado on-chain ao executar a fonte 0%).
  const aaveFlashSel = await selectFlashSource(
    ctx.client,
    ctx.chainConfig,
    position.debtAsset as Address,
    decision.flashloanAmount,
  );
  decision.flashSource = aaveFlashSel.flashSource;
  decision.flashPremiumBps = aaveFlashSel.flashPremiumBps;

  const built = buildLiquidationTx(position, decision, {
    executorAddress: ctx.executorContractAddress,
    chainConfig: ctx.chainConfig,
    profitReceiver: callerAddress,
    slippageBps: env.MAX_SLIPPAGE_BPS,
    // Pra MVP: usar 500 (0.05%) default. Em produção, capturar do calculator.
    preferredFeeTier: 500,
    // Expected output = flashloan × (1 + bonus) (ideal). Slippage real é validado no simulator.
    expectedSwapOutput: (decision.flashloanAmount *
      (10_000n + BigInt(position.liquidationBonusBps))) /
      10_000n,
    bribe: aaveBribe,
  });

  // 3. Simulator
  const sim = await simulateLiquidation({
    client: ctx.client,
    executorAddress: built.to,
    callerAddress,
    calldata: built.data,
  });

  // 3.5 Stale check — APENAS se vai submeter tx real (não em dryrun ou se sim falhou)
  // Confirma que borrower AINDA é liquidable antes de queimar gas. ~50ms RPC.
  if (env.STALE_CHECK_ENABLED && env.LIQUIDATOR_MODE !== 'dryrun' && sim.success && ctx.chainConfig.aave?.pool) {
    const hfThresholdWei = BigInt(Math.floor(env.HF_LIQUIDATABLE_THRESHOLD * 1e18));
    const staleCheck = await isAaveStillLiquidatable({
      client: ctx.client,
      poolAddress: ctx.chainConfig.aave.pool,
      borrower: position.borrower,
      hfThresholdWei,
      logger,
    });
    if (!staleCheck.stillLiquidatable) {
      logger.warn(
        {
          borrower: position.borrower,
          reason: staleCheck.reason,
          elapsedMs: staleCheck.elapsedMs,
        },
        `⏭️  Stale position descartada: ${staleCheck.reason}`,
      );
      return {
        status: 'reverted_pre_dispatch',
        reason: `stale position: ${staleCheck.reason ?? 'no longer liquidatable'}`,
      };
    }
  }

  // 4. Dispatcher
  return dispatch({
    mode: env.LIQUIDATOR_MODE,
    client: ctx.client,
    wallet: ctx.wallet,
    account: ctx.account,
    to: built.to,
    data: built.data,
    summary: {
      chain: ctx.chainConfig.name,
      protocol: 'aave-v3',
      borrower: built.summary.borrower,
      flashloanWei: built.summary.flashloanWei.toString(),
      debtAsset: built.summary.debtAsset,
      collateralAsset: built.summary.collateralAsset,
      expectedProfitUsd: decision.expectedProfitUsd.toFixed(2),
      slippageBps: decision.estimatedSlippageBps,
      withBribe: built.summary.withBribe,
    },
    simulationOk: sim.success,
    simulationGas: sim.gasUsed,
    simulationReason: sim.revertReason,
    expectedProfitWei: decision.expectedProfitWei,
    profitAssetDecimals: position.debtAssetDecimals,
    profitAssetSymbol: position.debtAssetSymbol,
    ethUsdPrice: env.ETH_USD_PRICE_ESTIMATE,
    pnlTracker,
    failureTracker,
    dedupTracker,
    positionKey,
    protocol: 'aave-v3',
    eventBus: deps.eventBus,
    borrower: position.borrower,
    chain: ctx.chainConfig.name,
    gasOracle: deps.gasOracle,
    pnlReconciler: deps.pnlReconciler,
    failureCollector: deps.failureCollector,
    expectedGasUsd: env.GAS_COST_USD_ESTIMATE,
    opportunityId: position.borrower,
    venue: marketLabel,
  });
}

/**
 * Pipeline pra Compound III: calc → build → sim → dispatch.
 * Mesma estrutura do Aave, mas com Comet `baseAmount` em vez de `debtToCover`.
 */
export async function runCompoundPipeline(
  position: CompoundLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  if (deps.tracer) {
    return deps.tracer.runInSpan(
      'liquidator.runCompoundPipeline',
      async (span) => {
        span.setAttributes({
          chain: deps.ctx.chainConfig.name,
          borrower: position.borrower,
          comet: position.cometName,
          protocol: 'compound-v3',
        });
        const result = await _runCompoundPipelineInner(position, deps);
        span.setAttribute('outcome', result.status);
        return result;
      },
    );
  }
  return _runCompoundPipelineInner(position, deps);
}

async function _runCompoundPipelineInner(
  position: CompoundLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  const { env, ctx, callerAddress, contractCapByDebtAsset, pnlTracker, failureTracker, dedupTracker, gasReserveTracker } = deps;

  if (pnlTracker?.isKillSwitchTriggered()) {
    return {
      status: 'reverted_pre_dispatch',
      reason: `kill switch active: ${pnlTracker.killReason() ?? 'unknown'}`,
    };
  }

  if (failureTracker?.inCooldown()) {
    const remainingS = Math.ceil(failureTracker.remainingCooldownMs() / 1000);
    return {
      status: 'reverted_pre_dispatch',
      reason: `cooldown ativo, retomada em ${remainingS}s`,
    };
  }

  if (gasReserveTracker?.shouldBlockDispatch()) {
    return {
      status: 'reverted_pre_dispatch',
      reason: `gas reserve critical (balance=${gasReserveTracker.stats().balanceEth} ETH)`,
    };
  }

  // Gate AutoPauseManager (Item 12 H10) — agrega sinais de health
  if (deps.autoPauseManager?.shouldPause()) {
    return {
      status: 'reverted_pre_dispatch',
      reason: `auto-pause active: ${deps.autoPauseManager.summary()}`,
    };
  }

  // Gate oracle staleness (Grupo B) — checa baseToken + collateralAsset Chainlink feeds
  if (deps.stalenessChecker) {
    const stale = await deps.stalenessChecker.checkAaveAssetsStaleness(
      ctx.chainConfig.aave.oracle,
      [position.baseToken, position.collateralAsset],
    );
    for (const [asset, result] of stale.entries()) {
      if (result.status === 'stale' || result.status === 'invalid') {
        logger.warn(
          { asset, status: result.status, age: result.age_seconds, threshold: result.threshold_seconds, reason: result.reason },
          `⏰ Oracle staleness gate (Compound): ${result.status}`,
        );
        return {
          status: 'reverted_pre_dispatch',
          reason: `oracle ${result.status} for ${asset} (age=${result.age_seconds}s)`,
        };
      }
    }
  }

  // Gate pause detection upstream (Grupo B) — Comet.isAbsorbPaused
  if (deps.pauseDetector) {
    const pause = await deps.pauseDetector.checkCometAbsorbPause(position.comet);
    if (pause.paused) {
      logger.warn(
        { reason: pause.reason, comet: position.comet },
        `⏸️  Comet absorb pause gate: ${pause.reason}`,
      );
      return {
        status: 'reverted_pre_dispatch',
        reason: `comet paused: ${pause.reason}`,
      };
    }
  }

  // Gate dedup: position composta com (comet, borrower) pra Compound
  const positionKey = compoundPositionKey(ctx.chainConfig.name, position.comet, position.borrower);
  if (dedupTracker) {
    const dedupCheck = dedupTracker.check(positionKey);
    if (dedupCheck.blocked) {
      return {
        status: 'reverted_pre_dispatch',
        reason: `dedup blocked: ${dedupCheck.status} há ${Math.round(dedupCheck.ageMs / 1000)}s`,
      };
    }
  }

  if (!ctx.chainConfig.uniswapV3?.quoterV2) {
    return { status: 'reverted_pre_dispatch', reason: 'no UniswapV3 QuoterV2 configured' };
  }

  // 1. Calculator — roda sempre pra LOGAR decision teórica + alimentar cache
  // B-5 fix: cap obrigatório em modo real (config error se faltar); dryrun usa fallback.
  let cap = contractCapByDebtAsset.get(position.baseToken.toLowerCase());
  if (!cap) {
    if (env.LIQUIDATOR_MODE !== 'dryrun') {
      logger.error(
        { baseToken: position.baseToken, mode: env.LIQUIDATOR_MODE },
        '🛑 contractCap não cacheado pra base token — bloqueando dispatch (boot bug)',
      );
      return { status: 'reverted_pre_dispatch', reason: 'contractCap missing for base token' };
    }
    cap = 1_000_000n * 10n ** BigInt(position.baseTokenDecimals);
  }
  const outcome = await calculateOptimalCompoundLiquidation(position, {
    env,
    client: ctx.client,
    quoterAddress: ctx.chainConfig.uniswapV3.quoterV2,
    contractCapWei: cap,
    oracle: deps.aaveOracle,
  });

  if (!outcome.ok) {
    logger.debug(
      { comet: position.cometName, borrower: position.borrower, reason: outcome.reason },
      `⏭️  Compound descartado: ${outcome.reason}`,
    );
    return { status: 'reverted_pre_dispatch', reason: outcome.reason };
  }

  const decision = outcome.decision;

  // OIE Etapa B — gate de edge ciente de OEV (prioriza Morpho; opt-in via MIN_OPPORTUNITY_EV_USD)
  const compoundEdge = liquidationEdgeGate('compound-v3', decision, deps, position.borrower);
  if (compoundEdge.skip) {
    logger.info({ borrower: position.borrower, reason: compoundEdge.reason }, `⏭️  ${compoundEdge.reason}`);
    return { status: 'reverted_pre_dispatch', reason: compoundEdge.reason };
  }

  // Gate executor: sem executor, log e retorna dryrun_skipped
  if (!ctx.executorContractAddress) {
    logger.info(
      {
        chain: ctx.chainConfig.name,
        comet: position.cometName,
        borrower: position.borrower,
        wouldBaseAmountWei: decision.flashloanAmount.toString(),
        wouldProfitUsd: decision.expectedProfitUsd.toFixed(2),
        slippageBps: decision.estimatedSlippageBps,
      },
      `🔭 [no-executor] Compound decision LOGADA mas não dispatcheada — sem contrato em ${ctx.chainConfig.name}`,
    );
    return { status: 'dryrun_skipped', reason: 'no executor deployed on chain' };
  }

  // 2. Builder
  // Expected swap output ≈ baseAmount + ~5% bonus em Compound (varia por collateral)
  const expectedSwapOutput = (decision.flashloanAmount * 10_500n) / 10_000n;
  // minCollateralReceived = 95% do que quoteCollateral retornaria (slippage protection on-chain)
  // Pra MVP: aceitar ~95% do collateralBalance proporcional ao baseAmount
  const baseAmountFraction = (decision.flashloanAmount * 10_000n) /
    (position.collateralBalanceWei > 0n ? position.collateralBalanceWei : 1n);
  const minCollateralReceivedWei = baseAmountFraction > 0n
    ? (position.collateralBalanceWei * baseAmountFraction * 95n) / (10_000n * 100n)
    : 1n;

  // Seletor de fonte de flashloan (Morpho/Balancer 0% → Aave 0,05%). Token = base do Comet.
  const compoundFlashSel = await selectFlashSource(
    ctx.client,
    ctx.chainConfig,
    position.baseToken as Address,
    decision.flashloanAmount,
  );
  decision.flashSource = compoundFlashSel.flashSource;
  decision.flashPremiumBps = compoundFlashSel.flashPremiumBps;

  // Compound não suporta bribe em v7.1 (removido por EIP-170 size limit).
  const built = buildCompoundLiquidationTx(position, decision, {
    executorAddress: ctx.executorContractAddress,
    chainConfig: ctx.chainConfig,
    profitReceiver: callerAddress,
    slippageBps: env.MAX_SLIPPAGE_BPS,
    preferredFeeTier: 500,
    expectedSwapOutput,
    minCollateralReceivedWei,
  });

  // 3. Simulator
  const sim = await simulateCompoundLiquidation({
    client: ctx.client,
    executorAddress: built.to,
    callerAddress,
    calldata: built.data,
  });

  // 3.5 Stale check Compound — Comet.isLiquidatable() é definitivo (não calcula HF off-chain)
  if (env.STALE_CHECK_ENABLED && env.LIQUIDATOR_MODE !== 'dryrun' && sim.success) {
    const staleCheck = await isCompoundStillLiquidatable({
      client: ctx.client,
      comet: position.comet,
      borrower: position.borrower,
      logger,
    });
    if (!staleCheck.stillLiquidatable) {
      logger.warn(
        {
          comet: position.cometName,
          borrower: position.borrower,
          reason: staleCheck.reason,
          elapsedMs: staleCheck.elapsedMs,
        },
        `⏭️  Stale Compound position descartada: ${staleCheck.reason}`,
      );
      return {
        status: 'reverted_pre_dispatch',
        reason: `stale position: ${staleCheck.reason ?? 'no longer liquidatable'}`,
      };
    }
  }

  // 4. Dispatcher
  return dispatch({
    mode: env.LIQUIDATOR_MODE,
    client: ctx.client,
    wallet: ctx.wallet,
    account: ctx.account,
    to: built.to,
    data: built.data,
    summary: {
      chain: ctx.chainConfig.name,
      protocol: 'compound-v3',
      comet: built.summary.cometName,
      borrower: built.summary.borrower,
      baseAmountWei: built.summary.baseAmountWei.toString(),
      baseToken: built.summary.baseToken,
      collateralAsset: built.summary.collateralAsset,
      expectedProfitUsd: decision.expectedProfitUsd.toFixed(2),
      slippageBps: decision.estimatedSlippageBps,
      withBribe: built.summary.withBribe,
    },
    simulationOk: sim.success,
    simulationGas: sim.gasUsed,
    simulationReason: sim.revertReason,
    expectedProfitWei: decision.expectedProfitWei,
    profitAssetDecimals: position.baseTokenDecimals,
    profitAssetSymbol: position.baseTokenSymbol,
    ethUsdPrice: env.ETH_USD_PRICE_ESTIMATE,
    pnlTracker,
    failureTracker,
    dedupTracker,
    positionKey,
    protocol: 'compound-v3',
    eventBus: deps.eventBus,
    borrower: position.borrower,
    chain: ctx.chainConfig.name,
    gasOracle: deps.gasOracle,
    pnlReconciler: deps.pnlReconciler,
    failureCollector: deps.failureCollector,
    expectedGasUsd: env.GAS_COST_USD_ESTIMATE,
    opportunityId: position.borrower,
  });
}

/**
 * Pipeline pra Morpho Blue: calc → build → sim → dispatch.
 *
 * Diferenças vs Aave/Compound:
 *  - Markets isolados (não pool global) — position já traz marketParams + totals
 *  - SEM gate de pause: Morpho Blue é imutável/permissionless (não tem pause admin)
 *  - SEM gate Chainlink staleness: usa oracle próprio por market (IOracle.price 1e36).
 *    A freshness do oracle do market é responsabilidade do market; sim cobre revert.
 *  - Conecta na caixa-preta igual aos outros: scorer (no discoveryTick), dedup,
 *    reconciler (protocol=morpho-blue + venue=marketId), failureCollector, eventBus.
 */
export async function runMorphoPipeline(
  position: MorphoLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  if (deps.tracer) {
    return deps.tracer.runInSpan(
      'liquidator.runMorphoPipeline',
      async (span) => {
        span.setAttributes({
          chain: deps.ctx.chainConfig.name,
          borrower: position.borrower,
          market: position.marketId,
          protocol: 'morpho-blue',
        });
        const result = await _runMorphoPipelineInner(position, deps);
        span.setAttribute('outcome', result.status);
        return result;
      },
    );
  }
  return _runMorphoPipelineInner(position, deps);
}

async function _runMorphoPipelineInner(
  position: MorphoLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  const { env, ctx, callerAddress, pnlTracker, failureTracker, dedupTracker, gasReserveTracker } = deps;

  // Gates compartilhados (kill / cooldown / gas / auto-pause)
  if (pnlTracker?.isKillSwitchTriggered()) {
    return { status: 'reverted_pre_dispatch', reason: `kill switch active: ${pnlTracker.killReason() ?? 'unknown'}` };
  }
  if (failureTracker?.inCooldown()) {
    const remainingS = Math.ceil(failureTracker.remainingCooldownMs() / 1000);
    return { status: 'reverted_pre_dispatch', reason: `cooldown ativo, retomada em ${remainingS}s` };
  }
  if (gasReserveTracker?.shouldBlockDispatch()) {
    return { status: 'reverted_pre_dispatch', reason: `gas reserve critical (balance=${gasReserveTracker.stats().balanceEth} ETH)` };
  }
  if (deps.autoPauseManager?.shouldPause()) {
    return { status: 'reverted_pre_dispatch', reason: `auto-pause active: ${deps.autoPauseManager.summary()}` };
  }

  // Gate dedup (key inclui marketId — não colide entre markets do mesmo borrower)
  const positionKey = morphoPositionKey(ctx.chainConfig.name, position.marketId, position.borrower);
  if (dedupTracker) {
    const dedupCheck = dedupTracker.check(positionKey);
    if (dedupCheck.blocked) {
      return { status: 'reverted_pre_dispatch', reason: `dedup blocked: ${dedupCheck.status} há ${Math.round(dedupCheck.ageMs / 1000)}s` };
    }
  }

  if (!ctx.chainConfig.uniswapV3?.quoterV2) {
    return { status: 'reverted_pre_dispatch', reason: 'no UniswapV3 QuoterV2 configured' };
  }
  if (!ctx.chainConfig.morpho?.morphoBlue) {
    return { status: 'reverted_pre_dispatch', reason: 'no Morpho Blue configured on chain' };
  }

  // 1. Calculator
  const outcome = await calculateOptimalMorphoLiquidation(position, {
    env,
    client: ctx.client,
    quoterAddress: ctx.chainConfig.uniswapV3.quoterV2,
    multiHopIntermediates: env.MULTI_HOP_SWAPS_ENABLED ? buildMultiHopIntermediates(ctx.chainConfig) : undefined,
  });

  if (!outcome.ok || !outcome.decision || !outcome.plan) {
    logger.debug(
      { market: position.marketId, borrower: position.borrower, reason: outcome.reason },
      `⏭️  Morpho descartado: ${outcome.reason}`,
    );
    return { status: 'reverted_pre_dispatch', reason: outcome.reason ?? 'morpho calc falhou' };
  }
  const decision = outcome.decision;
  const plan = outcome.plan;

  // OIE Etapa B — gate de edge ciente de OEV. Morpho tem recapture 0 → edge inteiro preservado.
  const morphoEdge = liquidationEdgeGate('morpho-blue', decision, deps, position.borrower);
  if (morphoEdge.skip) {
    logger.info({ borrower: position.borrower, reason: morphoEdge.reason }, `⏭️  ${morphoEdge.reason}`);
    return { status: 'reverted_pre_dispatch', reason: morphoEdge.reason };
  }

  // Gate executor: sem executor, loga decision teórica (calibração DRY_RUN)
  if (!ctx.executorContractAddress) {
    logger.info(
      {
        chain: ctx.chainConfig.name,
        market: `${position.collateralTokenSymbol}/${position.loanTokenSymbol}`,
        borrower: position.borrower,
        mode: plan.mode,
        wouldFlashloanWei: decision.flashloanAmount.toString(),
        wouldProfitUsd: decision.expectedProfitUsd.toFixed(2),
      },
      `🔭 [no-executor] Morpho decision LOGADA — sem contrato em ${ctx.chainConfig.name}`,
    );
    return { status: 'dryrun_skipped', reason: 'no executor deployed on chain' };
  }

  // Seletor de fonte de flashloan. Em Morpho liquidations, o próprio singleton empresta a 0%
  // (ganho mais óbvio — o contrato do Morpho já está no fluxo). Token = loanToken.
  const morphoFlashSel = await selectFlashSource(
    ctx.client,
    ctx.chainConfig,
    position.loanToken as Address,
    decision.flashloanAmount,
  );
  decision.flashSource = morphoFlashSel.flashSource;
  decision.flashPremiumBps = morphoFlashSel.flashPremiumBps;

  // 2. Builder
  const built = buildMorphoLiquidationTx(position, decision, plan, {
    executorAddress: ctx.executorContractAddress,
    morpho: ctx.chainConfig.morpho.morphoBlue,
    chainConfig: ctx.chainConfig,
    profitReceiver: callerAddress,
    slippageBps: env.MAX_SLIPPAGE_BPS,
    preferredFeeTier: 500,
    expectedSwapOutput: outcome.expectedSwapOutputWei ?? 0n,
  });

  // 3. Simulator
  const sim = await simulateMorphoLiquidation({
    client: ctx.client,
    executorAddress: built.to,
    callerAddress,
    calldata: built.data,
  });

  // 3.5 Stale check — re-lê position + recomputa isLiquidatable antes do submit real
  if (env.STALE_CHECK_ENABLED && env.LIQUIDATOR_MODE !== 'dryrun' && sim.success) {
    const stillLiq = isMorphoLiquidatable(
      { borrowShares: position.borrowShares, collateral: position.collateral },
      { totalBorrowAssets: position.totalBorrowAssets, totalBorrowShares: position.totalBorrowShares },
      position.collateralPrice,
      position.lltv,
    );
    if (!stillLiq) {
      return { status: 'reverted_pre_dispatch', reason: 'stale position: não mais liquidável (Morpho HF recovered)' };
    }
  }

  // 4. Dispatcher — conecta na caixa-preta (reconciler/failure/pnl/eventBus)
  return dispatch({
    mode: env.LIQUIDATOR_MODE,
    client: ctx.client,
    wallet: ctx.wallet,
    account: ctx.account,
    to: built.to,
    data: built.data,
    summary: {
      chain: ctx.chainConfig.name,
      protocol: 'morpho-blue',
      market: `${position.collateralTokenSymbol}/${position.loanTokenSymbol}`,
      borrower: built.summary.borrower,
      flashloanWei: built.summary.flashloanWei.toString(),
      loanToken: built.summary.loanToken,
      collateralToken: built.summary.collateralToken,
      mode: built.summary.mode,
      expectedProfitUsd: decision.expectedProfitUsd.toFixed(2),
      slippageBps: decision.estimatedSlippageBps,
      withBribe: built.summary.withBribe,
    },
    simulationOk: sim.success,
    simulationGas: sim.gasUsed,
    simulationReason: sim.revertReason,
    expectedProfitWei: decision.expectedProfitWei,
    profitAssetDecimals: position.loanTokenDecimals,
    profitAssetSymbol: position.loanTokenSymbol,
    ethUsdPrice: env.ETH_USD_PRICE_ESTIMATE,
    pnlTracker,
    failureTracker,
    dedupTracker,
    positionKey,
    protocol: 'morpho-blue',
    eventBus: deps.eventBus,
    borrower: position.borrower,
    chain: ctx.chainConfig.name,
    gasOracle: deps.gasOracle,
    pnlReconciler: deps.pnlReconciler,
    failureCollector: deps.failureCollector,
    expectedGasUsd: env.GAS_COST_USD_ESTIMATE,
    opportunityId: position.borrower,
    venue: position.marketId,
  });
}

/**
 * Pipeline pra Moonwell (Compound V2 fork). Tx vai pro ZeusMoonwellLiquidator
 * (contrato SEPARADO — moonwellLiquidatorAddress, não o executor padrão).
 *
 * Conectado na caixa-preta: scorer (discoveryTick), reconciler (protocol=moonwell),
 * failureCollector, dedup, eventBus.
 */
export async function runMoonwellPipeline(
  position: MoonwellLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  if (deps.tracer) {
    return deps.tracer.runInSpan(
      'liquidator.runMoonwellPipeline',
      async (span) => {
        span.setAttributes({
          chain: deps.ctx.chainConfig.name,
          borrower: position.borrower,
          protocol: 'moonwell',
        });
        const result = await _runMoonwellPipelineInner(position, deps);
        span.setAttribute('outcome', result.status);
        return result;
      },
    );
  }
  return _runMoonwellPipelineInner(position, deps);
}

async function _runMoonwellPipelineInner(
  position: MoonwellLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  const { env, ctx, callerAddress, contractCapByDebtAsset, pnlTracker, failureTracker, dedupTracker, gasReserveTracker } = deps;

  // Gates compartilhados
  if (pnlTracker?.isKillSwitchTriggered()) {
    return { status: 'reverted_pre_dispatch', reason: `kill switch active: ${pnlTracker.killReason() ?? 'unknown'}` };
  }
  if (failureTracker?.inCooldown()) {
    const remainingS = Math.ceil(failureTracker.remainingCooldownMs() / 1000);
    return { status: 'reverted_pre_dispatch', reason: `cooldown ativo, retomada em ${remainingS}s` };
  }
  if (gasReserveTracker?.shouldBlockDispatch()) {
    return { status: 'reverted_pre_dispatch', reason: `gas reserve critical (balance=${gasReserveTracker.stats().balanceEth} ETH)` };
  }
  if (deps.autoPauseManager?.shouldPause()) {
    return { status: 'reverted_pre_dispatch', reason: `auto-pause active: ${deps.autoPauseManager.summary()}` };
  }

  // Gate dedup (key: chain:moonwell:mTokenBorrowed:borrower via compoundPositionKey reaproveitado)
  const positionKey = compoundPositionKey(ctx.chainConfig.name, position.mTokenBorrowed, position.borrower)
    .replace(':compound-v3:', ':moonwell:');
  if (dedupTracker) {
    const dedupCheck = dedupTracker.check(positionKey);
    if (dedupCheck.blocked) {
      return { status: 'reverted_pre_dispatch', reason: `dedup blocked: ${dedupCheck.status} há ${Math.round(dedupCheck.ageMs / 1000)}s` };
    }
  }

  if (!ctx.chainConfig.uniswapV3?.quoterV2) {
    return { status: 'reverted_pre_dispatch', reason: 'no UniswapV3 QuoterV2 configured' };
  }
  if (!deps.moonwellLiquidatorAddress) {
    return { status: 'reverted_pre_dispatch', reason: 'no ZeusMoonwellLiquidator deployed (MOONWELL_LIQUIDATOR_ADDRESS ausente)' };
  }

  // 1. Calculator
  const cap = contractCapByDebtAsset.get(position.borrowedUnderlying.toLowerCase());
  const outcome = calculateOptimalMoonwellLiquidation(position, { env, capWei: cap });
  if (!outcome.ok || !outcome.decision) {
    logger.debug(
      { borrower: position.borrower, reason: outcome.reason },
      `⏭️  Moonwell descartado: ${outcome.reason}`,
    );
    return { status: 'reverted_pre_dispatch', reason: outcome.reason ?? 'moonwell calc falhou' };
  }
  const decision = outcome.decision;

  // OIE Etapa B — gate de edge ciente de OEV. Moonwell tem MEV tax (~99% recapture) → tende a cair.
  const moonwellEdge = liquidationEdgeGate('moonwell', decision, deps, position.borrower);
  if (moonwellEdge.skip) {
    logger.info({ borrower: position.borrower, reason: moonwellEdge.reason }, `⏭️  ${moonwellEdge.reason}`);
    return { status: 'reverted_pre_dispatch', reason: moonwellEdge.reason };
  }

  // Seletor de fonte de flashloan (Morpho/Balancer 0% → Aave 0,05%). Token = borrowedUnderlying.
  const moonwellFlashSel = await selectFlashSource(
    ctx.client,
    ctx.chainConfig,
    position.borrowedUnderlying as Address,
    decision.flashloanAmount,
  );
  decision.flashSource = moonwellFlashSel.flashSource;
  decision.flashPremiumBps = moonwellFlashSel.flashPremiumBps;

  // 2. Builder
  const built = buildMoonwellLiquidationTx(position, decision, {
    moonwellLiquidatorAddress: deps.moonwellLiquidatorAddress,
    chainConfig: ctx.chainConfig,
    profitReceiver: callerAddress,
    slippageBps: env.MAX_SLIPPAGE_BPS,
    preferredFeeTier: 500,
    expectedSwapOutput: outcome.expectedSwapOutputWei ?? 0n,
  });

  // 3. Simulator
  const sim = await simulateMoonwellLiquidation({
    client: ctx.client,
    executorAddress: built.to,
    callerAddress,
    calldata: built.data,
  });

  // 4. Dispatcher — protocol='moonwell' na caixa-preta
  return dispatch({
    mode: env.LIQUIDATOR_MODE,
    client: ctx.client,
    wallet: ctx.wallet,
    account: ctx.account,
    to: built.to,
    data: built.data,
    summary: {
      chain: ctx.chainConfig.name,
      protocol: 'moonwell',
      borrower: built.summary.borrower,
      market: `${position.collateralSymbol}/${position.borrowedSymbol}`,
      repayAmountWei: built.summary.repayAmountWei.toString(),
      expectedProfitUsd: decision.expectedProfitUsd.toFixed(2),
    },
    simulationOk: sim.success,
    simulationGas: sim.gasUsed,
    simulationReason: sim.revertReason,
    expectedProfitWei: decision.expectedProfitWei,
    profitAssetDecimals: position.borrowedDecimals,
    profitAssetSymbol: position.borrowedSymbol,
    ethUsdPrice: env.ETH_USD_PRICE_ESTIMATE,
    pnlTracker,
    failureTracker,
    dedupTracker,
    positionKey,
    protocol: 'moonwell',
    eventBus: deps.eventBus,
    borrower: position.borrower,
    chain: ctx.chainConfig.name,
    gasOracle: deps.gasOracle,
    pnlReconciler: deps.pnlReconciler,
    failureCollector: deps.failureCollector,
    expectedGasUsd: env.GAS_COST_USD_ESTIMATE,
    opportunityId: position.borrower,
    venue: 'moonwell',
  });
}
