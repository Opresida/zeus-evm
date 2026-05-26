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
import { calculateOptimalLiquidation } from './protocols/aave/calculator';
import { buildLiquidationTx } from './protocols/aave/builder';
import { simulateLiquidation } from './protocols/aave/simulator';
import { calculateOptimalCompoundLiquidation } from './protocols/compound/calculator';
import { buildCompoundLiquidationTx } from './protocols/compound/builder';
import { simulateCompoundLiquidation } from './protocols/compound/simulator';
import { dispatch, triggerKillSwitchOnChain } from './dispatcher';
import type { PnlTracker } from './pnlTracker';
import type { FailureTracker } from './failureTracker';
import type { PositionDedupTracker } from './positionDedup';
import { aavePositionKey, compoundPositionKey } from './positionDedup';

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
}

export async function runAavePipeline(
  position: AaveLiquidatablePosition,
  deps: PipelineDeps,
): Promise<DispatchOutcome> {
  const { env, ctx, callerAddress, contractCapByDebtAsset, pnlTracker, failureTracker, dedupTracker } = deps;

  // Gate kill switch: se PnL tracker está triggered, abortar antes de qualquer trabalho
  if (pnlTracker?.isKillSwitchTriggered()) {
    return {
      status: 'reverted_pre_dispatch',
      reason: `kill switch active: ${pnlTracker.killReason() ?? 'unknown'}`,
    };
  }

  // Gate cooldown: se failure tracker está em cooldown, abortar
  if (failureTracker?.inCooldown()) {
    const remainingS = Math.ceil(failureTracker.remainingCooldownMs() / 1000);
    return {
      status: 'reverted_pre_dispatch',
      reason: `cooldown ativo, retomada em ${remainingS}s`,
    };
  }

  // Gate dedup: se position está em pending/recent confirmed/failed, abortar
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

  // 2. Builder
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
  });

  // 3. Simulator
  const sim = await simulateLiquidation({
    client: ctx.client,
    executorAddress: built.to,
    callerAddress,
    calldata: built.data,
  });

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
  const { env, ctx, callerAddress, contractCapByDebtAsset, pnlTracker, failureTracker, dedupTracker } = deps;

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
  });
}
