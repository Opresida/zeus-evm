/**
 * ZEUS EVM — Monitor entrypoint.
 *
 * Loop principal:
 *   1. Discovery (a cada 60s): query subgraph Aave V3 Base → lista de positions com debt
 *   2. On-chain HF check (a cada bloco): pra positions "em risco" (HF < 1.05),
 *      chama getUserAccountData() pra HF real-time
 *   3. Trigger (HF < 1.0): constrói LiquidationPlan + simula + (no futuro) submete
 *
 * Modo DRY_RUN: detecta + simula + loga, mas NÃO submete tx (KILL_SWITCH=true).
 */

import type { Address, PublicClient } from 'viem';

import { loadConfig } from './config';
import { logger } from './logger';
import { getChainContext, type ChainContext } from './chainContext';
import { fetchAllAaveV3Candidates } from './protocols/aaveV3';
import {
  getUserAccountDataBatch,
  filterAtRisk,
  hfToNumber,
  baseToUsd,
  type UserAccountData,
} from './healthFactor';

type AnyClient = PublicClient<any, any>;

const DISCOVERY_INTERVAL_MS = 60_000;
const HF_CHECK_INTERVAL_MS = 10_000; // cada 5 blocos Base (~10s)

interface MonitorState {
  positionsInRisk: Map<Address, UserAccountData>; // cache de positions HF < 1.05
}

async function discoveryLoop(
  env: ReturnType<typeof loadConfig>,
  ctx: ChainContext,
  state: MonitorState,
): Promise<void> {
  if (!env.THEGRAPH_API_KEY) {
    logger.warn('THEGRAPH_API_KEY não configurada — pulando discovery (modo on-chain only)');
    return;
  }

  try {
    logger.info(
      { chain: ctx.chainConfig.name, subgraphId: ctx.subgraphId },
      `🔍 Discovery: buscando candidatos Aave V3 ${ctx.chainConfig.name} via subgraph...`,
    );
    const candidates = await fetchAllAaveV3Candidates({
      apiKey: env.THEGRAPH_API_KEY,
      subgraphId: ctx.subgraphId,
      maxUsers: 1000,
    });

    logger.info({ count: candidates.length }, `📋 ${candidates.length} candidatos com borrowedReservesCount > 0`);

    if (candidates.length === 0) return;

    // On-chain HF check via Multicall3 — usa pool da chain ativa
    const users = candidates.map((c) => c.user);
    const accountDataList = await getUserAccountDataBatch(
      ctx.client,
      ctx.chainConfig.aave.pool,
      users,
    );

    // Filtrar dust
    const minDebtBase = BigInt(Math.floor(env.MIN_DEBT_USD * 1e8));
    const withRealDebt = accountDataList.filter((u) => u.totalDebtBase >= minDebtBase);

    const atRisk = filterAtRisk(withRealDebt, env.HF_AT_RISK_THRESHOLD);
    logger.info(
      {
        chain: ctx.chainConfig.name,
        candidates: candidates.length,
        scanned: accountDataList.length,
        withDebt: withRealDebt.length,
        atRisk: atRisk.length,
        threshold: env.HF_AT_RISK_THRESHOLD,
      },
      `🎯 [${ctx.chainConfig.shortName}] ${withRealDebt.length} com debt ≥ $${env.MIN_DEBT_USD} (de ${accountDataList.length}); ${atRisk.length} em risco (HF < ${env.HF_AT_RISK_THRESHOLD})`,
    );

    // Atualiza cache state
    state.positionsInRisk.clear();
    for (const u of atRisk) {
      state.positionsInRisk.set(u.user, u);
    }

    // Loga top 5 mais próximas de liquidar
    for (const u of atRisk.slice(0, 5)) {
      logger.info(
        {
          user: u.user,
          hf: hfToNumber(u.healthFactor).toFixed(4),
          collateralUsd: baseToUsd(u.totalCollateralBase).toFixed(2),
          debtUsd: baseToUsd(u.totalDebtBase).toFixed(2),
        },
        `  ⚠️  ${u.user.slice(0, 10)}... HF=${hfToNumber(u.healthFactor).toFixed(4)} debt=$${baseToUsd(u.totalDebtBase).toFixed(0)}`,
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      'Discovery falhou',
    );
  }
}

async function hfCheckLoop(
  env: ReturnType<typeof loadConfig>,
  ctx: ChainContext,
  state: MonitorState,
): Promise<void> {
  if (state.positionsInRisk.size === 0) return;

  const users = Array.from(state.positionsInRisk.keys());
  const liquidatableThreshold = BigInt(Math.floor(env.HF_LIQUIDATABLE_THRESHOLD * 1e18));

  try {
    const accountDataList = await getUserAccountDataBatch(
      ctx.client,
      ctx.chainConfig.aave.pool,
      users,
    );

    let liquidatable = 0;
    for (const u of accountDataList) {
      // Atualiza cache
      state.positionsInRisk.set(u.user, u);

      if (u.totalDebtBase > 0n && u.healthFactor < liquidatableThreshold) {
        liquidatable++;
        logger.warn(
          {
            user: u.user,
            hf: hfToNumber(u.healthFactor).toFixed(4),
            collateralUsd: baseToUsd(u.totalCollateralBase).toFixed(2),
            debtUsd: baseToUsd(u.totalDebtBase).toFixed(2),
          },
          `🔥 LIQUIDÁVEL: ${u.user.slice(0, 10)}... HF=${hfToNumber(u.healthFactor).toFixed(4)}`,
        );
        // TODO Fase 5b+: construir LiquidationPlan + simular + submeter
        // Por enquanto (DRY_RUN), só logamos.
      }
    }

    if (liquidatable === 0) {
      logger.debug({ scanned: users.length }, `HF check: ${users.length} positions, 0 liquidáveis`);
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      'HF check loop falhou',
    );
  }
}

async function main() {
  const env = loadConfig();
  const ctx = getChainContext(env);

  logger.info(
    {
      chainId: ctx.chainConfig.chainId,
      chain: ctx.chainConfig.name,
      isTestnet: ctx.chainConfig.isTestnet ?? false,
      subgraphId: ctx.subgraphId,
      executorContract: ctx.executorContractAddress ?? '(não deployado)',
      hasApiKey: !!env.THEGRAPH_API_KEY,
      hfAtRisk: env.HF_AT_RISK_THRESHOLD,
      hfLiquidatable: env.HF_LIQUIDATABLE_THRESHOLD,
      minDebtUsd: env.MIN_DEBT_USD,
      minProfitUsd: env.MIN_LIQUIDATION_PROFIT_USD,
    },
    `🚀 Monitor boot (DRY_RUN mode) — chain=${ctx.chainConfig.name}`,
  );

  const blockNumber = await ctx.client.getBlockNumber();
  logger.info({ blockNumber: blockNumber.toString() }, `✅ Conectado em ${ctx.chainConfig.name}`);

  const state: MonitorState = {
    positionsInRisk: new Map(),
  };

  // ─── Discovery inicial ───
  await discoveryLoop(env, ctx, state);

  // ─── Loops periódicos ───
  setInterval(() => {
    discoveryLoop(env, ctx, state).catch((err) =>
      logger.error({ err }, 'discoveryLoop iteration failed'),
    );
  }, DISCOVERY_INTERVAL_MS);

  setInterval(() => {
    hfCheckLoop(env, ctx, state).catch((err) =>
      logger.error({ err }, 'hfCheckLoop iteration failed'),
    );
  }, HF_CHECK_INTERVAL_MS);

  await new Promise(() => {});
}

main().catch((err) => {
  logger.error({ err }, 'Monitor crashed at boot');
  process.exit(1);
});
