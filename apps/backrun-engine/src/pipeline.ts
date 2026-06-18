/**
 * Backrun pipeline — consome WhaleSwap, planeja arb, valida, dispatcha.
 *
 * Trigger: o handler `processWhaleSwap` é registrado como subscriber no eventBus.
 * Quando um WhaleSwapDetectedEvent (ou WhaleSwap struct injetado direto) chega:
 *
 *   1. findPairForWhale → mapeia tokens do whale pra TargetPair conhecido
 *   2. planBackrun → sample logarítmico de amountIn em DEX oposto
 *   3. validateBackrunProfit → simula on-chain executeFlashloanArbitrage
 *   4. dispatch → submete tx (ou skip em dryrun)
 *
 * Gates pre-dispatch (espelham liquidator):
 *   - kill switch (pnl tracker)
 *   - cooldown (failure tracker)
 *
 * Métricas: cada estágio emite evento tipado pro eventBus. Sinks (Discord,
 * webhook, futuro WebSocket mobile) consomem.
 */

import type { Address } from 'viem';
import {
  getTargetPairsForChain,
  type TargetPair,
} from '@zeus-evm/chain-config';
import {
  findPairForWhale,
  planBackrun,
  validateBackrunProfit,
  type WhaleSwap,
  type BackrunOpportunity,
} from '@zeus-evm/strategy';
import {
  computeBribeSlippageFloor,
  scoreBackrunOpportunity,
  type EventBus,
  type PnlTracker,
  type FailureTracker,
  type GasOracle,
  type GasWarLevel,
  type BackrunOpportunityFoundEvent,
  type BackrunRejectedEvent,
} from '@zeus-evm/execution-utils';

import type { BackrunEnv, BackrunMode } from './config';
import type { BackrunChainContext } from './chainContext';
import type { BribeCalculator, GasWarDetector, CompetitionTracker } from './bribe';
import type { RelayRouter } from './bundling';
import { logger } from './logger';
import { dispatchBackrun } from './dispatcher';

export interface BackrunPipelineDeps {
  env: BackrunEnv;
  chainCtx: BackrunChainContext;
  mode: BackrunMode;
  eventBus: EventBus;
  pnlTracker: PnlTracker;
  failureTracker: FailureTracker;
  gasOracle: GasOracle;
  /** Bribe calculator. Opcional em DRY_RUN (sem bribe = comportamento v6). */
  bribeCalculator?: BribeCalculator;
  /** Gas war detector. Opcional — sem ele, level = 'normal' sempre. */
  gasWarDetector?: GasWarDetector;
  /** Competition tracker. Opcional. */
  competitionTracker?: CompetitionTracker;
  /** Relay router pra bundle privado. Opcional — sem ele, fallback mempool público. */
  relayRouter?: RelayRouter;
  /** Pares conhecidos. Default resolve via getTargetPairsForChain(chainId). */
  pairs?: readonly TargetPair[];
  /** PnL Reconciler (Item 10) — gera análise rica expected vs realized. */
  pnlReconciler?: import('@zeus-evm/execution-utils').PnlReconciler;
  /** Failure Collector (Item 4) — schema rico em JSONL. */
  failureCollector?: import('@zeus-evm/execution-utils').FailureCollector;
  /** MetricRegistry (Fase 7b) — cronometra planBackrun + dispatch (histogramas Prometheus). */
  metricRegistry?: import('@zeus-evm/execution-utils').MetricRegistry;
}

export interface BackrunPipelineResult {
  status: 'dispatched' | 'dryrun_skipped' | 'rejected';
  reason?: string;
  netProfitUsd?: number;
  pendingTxHash: `0x${string}`;
}

/**
 * Handler do whale swap. Plug isso no eventBus.subscribe ou chame direto.
 */
export async function processWhaleSwap(
  whale: WhaleSwap,
  deps: BackrunPipelineDeps,
): Promise<BackrunPipelineResult> {
  const {
    env,
    chainCtx,
    mode,
    eventBus,
    pnlTracker,
    failureTracker,
    gasOracle,
    bribeCalculator,
    gasWarDetector,
    competitionTracker,
    relayRouter,
  } = deps;
  const pairs = deps.pairs ?? getTargetPairsForChain(chainCtx.chainId);
  const nowIso = () => new Date().toISOString();

  // Gate 1: kill switch (PnL > limit)
  if (pnlTracker.isKillSwitchTriggered()) {
    return reject(eventBus, chainCtx.chainName, mode, whale, 'kill_switch_active', 'plan');
  }

  // Gate 2: cooldown
  if (failureTracker.inCooldown()) {
    const remainingMs = failureTracker.remainingCooldownMs();
    return reject(
      eventBus,
      chainCtx.chainName,
      mode,
      whale,
      `cooldown active (${Math.ceil(remainingMs / 1000)}s left)`,
      'plan',
    );
  }

  // Gate 3: resolver TargetPair
  const pair = findPairForWhale(whale, pairs);
  if (!pair) {
    return reject(
      eventBus,
      chainCtx.chainName,
      mode,
      whale,
      'whale swap em par fora do universo de target pairs da chain ativa',
      'plan',
    );
  }

  // Gate 4: executor address
  if (!chainCtx.executorAddress) {
    return reject(
      eventBus,
      chainCtx.chainName,
      mode,
      whale,
      'EXECUTOR_CONTRACT_ADDRESS não configurado',
      'plan',
    );
  }

  // Caller pra simulação: usa account em dryrun se disponível, senão usa
  // executor mesmo como caller (eth_call não precisa de saldo real).
  const callerAddress: Address =
    chainCtx.account ?? (chainCtx.executorAddress as Address);

  // Caps em wei baseados em USD
  const minTradeWei = usdToWeiTokenIn(env.MIN_BACKRUN_FLASHLOAN_USD, whale, pair);
  const maxTradeWei = usdToWeiTokenIn(env.MAX_BACKRUN_FLASHLOAN_USD, whale, pair);
  if (maxTradeWei <= 0n || minTradeWei <= 0n) {
    return reject(
      eventBus,
      chainCtx.chainName,
      mode,
      whale,
      `cap inválido min=${minTradeWei} max=${maxTradeWei}`,
      'plan',
    );
  }

  // Plan (= "calculator" do motor 3) — cronometrado pro histograma (Fase 7b).
  const blockNumber = await chainCtx.client.getBlockNumber();
  const calcStart = Date.now();
  const opp = await planBackrun({
    client: chainCtx.client,
    whale,
    pair,
    uniswapV3Quoter: chainCtx.uniswapV3Quoter,
    aerodromeRouter: chainCtx.velodromeStyleRouter,
    aerodromeFactory: chainCtx.velodromeStyleFactory,
    minTradeWei,
    maxTradeWei,
    blockNumber,
    sampleSize: env.BACKRUN_SAMPLE_SIZE,
  });
  deps.metricRegistry?.observe('zeus_calculator_duration_seconds', (Date.now() - calcStart) / 1000, {
    chain: chainCtx.chainName,
    protocol: 'backrun',
  });

  if (!opp) {
    return reject(
      eventBus,
      chainCtx.chainName,
      mode,
      whale,
      'planBackrun retornou null — sem combinação lucrativa',
      'plan',
    );
  }

  // Classifica gas war UMA vez (reusado no OIE score e na decisão de bribe).
  const gasWar = gasWarDetector?.classify({
    pendingTxToKnownRouters: competitionTracker?.stats().pendingTxToKnownRouters ?? 0,
    recentFailures: failureTracker.stats().consecutiveFailures,
  }) ?? { level: 'normal' as const, signals: undefined };
  const gasWarLevel: GasWarLevel = gasWar.level;

  // OIE Fase 4 — score competitor-aware (EV ajustado a risco pelo nível de gas war).
  // Bruto aqui (sem bribe); o gate por EV líquido roda após decidir o bribe.
  const oppScore = scoreBackrunOpportunity({
    profitUsd: opp.profitUsd,
    gasUsd: env.GAS_COST_USD_ESTIMATE,
    slippageBps: env.MAX_SLIPPAGE_BPS,
    gasWarLevel,
    opportunityId: whale.pendingTxHash,
  });

  // Emit "opportunity found" pro bus (carrega o score pro ledger DuckDB)
  const oppEvent: BackrunOpportunityFoundEvent = {
    type: 'backrun.opportunity_found',
    timestamp: nowIso(),
    chain: chainCtx.chainName,
    mode,
    severity: 'info',
    pendingTxHash: whale.pendingTxHash,
    pairId: pair.id,
    buyVenue: opp.buyQuote.source,
    sellVenue: opp.sellQuote.source,
    expectedProfitUsd: opp.profitUsd,
    estimatedSlippageBps: 0, // refinar quando integrar slippage cache
    opportunityScore: oppScore.score,
    riskAdjustedEvUsd: oppScore.evUsd,
  };
  eventBus.emit(oppEvent);

  // Decide bribe ANTES de validar (precisa de bribe correto na simulação).
  // Computa slippage floor off-chain via Quoter pra proteger contra sandwich
  // do swap inline UniV3 da BribeManager (Audit Pass 4 H-01).
  let bribe: import('@zeus-evm/strategy').BribeConfig | undefined;
  let bribeUsd = 0;
  if (bribeCalculator) {
    // Calcula slippage floor antes do decide() (precisa do bribeBps pra estimar target).
    // profitToken == pair.tokenA (mesma moeda do flashloan, onde profit aparece).
    let swapSlippageFloorWei: bigint | undefined;
    const bribeBpsForLevel = bribeCalculator.getBpsForLevel(gasWar.level);
    const floor = await computeBribeSlippageFloor({
      client: chainCtx.client,
      quoterAddress: chainCtx.uniswapV3Quoter,
      weth: chainCtx.chainConfig.tokens.WETH,
      profitToken: pair.tokenA,
      profitTokenDecimals: pair.decimalsA,
      expectedProfitWei: opp.profitWei,
      bribeBps: BigInt(bribeBpsForLevel),
      swapFeeTier: bribeCalculator.getDefaultSwapFeeTier(),
      slippageBps: bribeCalculator.getDefaultSwapSlippageBps(),
    });
    if (floor.ok) {
      swapSlippageFloorWei = floor.minBribeWei;
    } else {
      logger.warn(
        { profitToken: pair.tokenA, reason: floor.reason },
        `⚠️  Bribe slippage floor falhou (${floor.reason}) — usando apenas floor USD`,
      );
    }

    const decision = bribeCalculator.decide({
      expectedNetProfitUsd: opp.profitUsd,
      gasWarLevel: gasWar.level,
      signals: gasWar.signals,
      swapSlippageFloorWei,
    });

    if (decision.skip) {
      return reject(
        eventBus,
        chainCtx.chainName,
        mode,
        whale,
        decision.reason,
        'profit_below_threshold',
      );
    }
    bribe = decision.bribe;
    bribeUsd = decision.bribeUsd;
  }

  // OIE Fase 4 — gate opt-in por EV ajustado a risco (líquido de bribe + gas).
  // Default desligado (env ausente). Corta corridas que historicamente não pagam
  // o risco de competição ANTES de gastar gas, mesmo que o profit bruto passe.
  if (env.MIN_OPPORTUNITY_EV_USD != null) {
    const netEvUsd = scoreBackrunOpportunity({
      profitUsd: opp.profitUsd,
      gasUsd: env.GAS_COST_USD_ESTIMATE,
      bribeUsd,
      slippageBps: env.MAX_SLIPPAGE_BPS,
      gasWarLevel,
    }).evUsd;
    if (netEvUsd < env.MIN_OPPORTUNITY_EV_USD) {
      return reject(
        eventBus,
        chainCtx.chainName,
        mode,
        whale,
        `EV ajustado a risco $${netEvUsd.toFixed(2)} < mínimo $${env.MIN_OPPORTUNITY_EV_USD.toFixed(2)} (gasWar=${gasWarLevel})`,
        'profit_below_threshold',
      );
    }
  }

  // Validate + simulate (com bribe quando configurado)
  const validation = await validateBackrunProfit({
    client: chainCtx.client,
    opp,
    executorAddress: chainCtx.executorAddress,
    callerAddress,
    slippageBps: env.MAX_SLIPPAGE_BPS,
    minNetProfitUsd: env.MIN_BACKRUN_PROFIT_USD,
    estimatedGasUsd: env.GAS_COST_USD_ESTIMATE,
    blockNumber,
    bribe,
  });

  if (!validation.passed) {
    return reject(
      eventBus,
      chainCtx.chainName,
      mode,
      whale,
      validation.reason ?? 'validation falhou',
      validation.simulation?.success === false ? 'simulate' : 'profit_below_threshold',
    );
  }

  // Dispatch
  const result = await dispatchBackrun({
    mode,
    chainCtx,
    env,
    eventBus,
    pnlTracker,
    failureTracker,
    gasOracle,
    opp,
    flashloanAsset: validation.flashloanAsset!,
    flashloanAmount: validation.flashloanAmount!,
    calldata: validation.calldata!,
    netProfitUsd: validation.netProfitUsd,
    simulationGas: validation.simulation?.gasUsed,
    relayRouter,
    pnlReconciler: deps.pnlReconciler,
    failureCollector: deps.failureCollector,
    metricRegistry: deps.metricRegistry,
  });

  logger.info(
    {
      pendingTxHash: whale.pendingTxHash,
      pairId: pair.id,
      netProfitUsd: validation.netProfitUsd.toFixed(4),
      status: result.status,
    },
    `🎯 Backrun ${result.status} — ${pair.id} net=$${validation.netProfitUsd.toFixed(2)}`,
  );

  return {
    status: result.status,
    netProfitUsd: validation.netProfitUsd,
    pendingTxHash: whale.pendingTxHash,
    reason: result.reason,
  };
}

function reject(
  eventBus: EventBus,
  chainName: string,
  mode: BackrunMode,
  whale: WhaleSwap,
  reason: string,
  stage: BackrunRejectedEvent['stage'],
): BackrunPipelineResult {
  const event: BackrunRejectedEvent = {
    type: 'backrun.rejected',
    timestamp: new Date().toISOString(),
    chain: chainName,
    mode,
    severity: 'info',
    pendingTxHash: whale.pendingTxHash,
    reason,
    stage,
  };
  eventBus.emit(event);
  logger.info(
    { stage, reason, pair: `${whale.tokenInSymbol ?? '?'}/${whale.tokenOutSymbol ?? '?'}` },
    `⏭️ Backrun rejeitado (${stage}): ${reason}`,
  );
  return { status: 'rejected', reason, pendingTxHash: whale.pendingTxHash };
}

/**
 * Converte USD em wei do tokenIn do whale, usando estimatedUsdValue do pair.
 */
function usdToWeiTokenIn(usd: number, whale: WhaleSwap, pair: TargetPair): bigint {
  const tokenInUsd =
    whale.tokenIn.toLowerCase() === pair.tokenA.toLowerCase()
      ? pair.estimatedUsdValueA
      : pair.estimatedUsdValueB;
  if (!tokenInUsd || tokenInUsd <= 0) return 0n;
  const tokens = usd / tokenInUsd;
  const scaled = Math.floor(tokens * Math.pow(10, whale.tokenInDecimals));
  return BigInt(scaled);
}

/** Re-export pra apps/smoke consumirem o resultado tipado. */
export type { BackrunOpportunity };
