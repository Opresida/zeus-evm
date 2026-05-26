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
  DispatchOutcome,
} from './types';
import type { BribeConfig } from '@zeus-evm/strategy';
import { calculateOptimalLiquidation } from './protocols/aave/calculator';
import { buildLiquidationTx } from './protocols/aave/builder';
import { simulateLiquidation } from './protocols/aave/simulator';
import { calculateOptimalCompoundLiquidation } from './protocols/compound/calculator';
import { buildCompoundLiquidationTx } from './protocols/compound/builder';
import { simulateCompoundLiquidation } from './protocols/compound/simulator';
import { dispatch, triggerKillSwitchOnChain } from './dispatcher';
import {
  aavePositionKey,
  compoundPositionKey,
  computeBribeSlippageFloor,
  type PnlTracker,
  type FailureTracker,
  type PositionDedupTracker,
  type GasReserveTracker,
  type EventBus,
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

export async function runAavePipeline(
  position: AaveLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  const { env, ctx, callerAddress, contractCapByDebtAsset, pnlTracker, failureTracker, dedupTracker, gasReserveTracker } = deps;

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

  // Gate dedup
  const positionKey = aavePositionKey(ctx.chainConfig.name, position.borrower);
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
  const cap = contractCapByDebtAsset.get(position.debtAsset.toLowerCase())
    ?? BigInt(10 ** 20); // fallback alto se ainda não cacheado (não bloqueia)
  const outcome = await calculateOptimalLiquidation(position, {
    env,
    client: ctx.client,
    quoterAddress: ctx.chainConfig.uniswapV3.quoterV2,
    contractCapWei: cap,
  });

  if (!outcome.ok) {
    logger.debug(
      { borrower: position.borrower, reason: outcome.reason },
      `⏭️  Descartado pre-build: ${outcome.reason}`,
    );
    return { status: 'reverted_pre_dispatch', reason: outcome.reason };
  }

  const decision = outcome.decision;

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
  const cap = contractCapByDebtAsset.get(position.baseToken.toLowerCase()) ?? BigInt(10 ** 20);
  const outcome = await calculateOptimalCompoundLiquidation(position, {
    env,
    client: ctx.client,
    quoterAddress: ctx.chainConfig.uniswapV3.quoterV2,
    contractCapWei: cap,
  });

  if (!outcome.ok) {
    logger.debug(
      { comet: position.cometName, borrower: position.borrower, reason: outcome.reason },
      `⏭️  Compound descartado: ${outcome.reason}`,
    );
    return { status: 'reverted_pre_dispatch', reason: outcome.reason };
  }

  const decision = outcome.decision;

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
  });
}
