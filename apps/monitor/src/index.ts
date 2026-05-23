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

import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { base } from 'viem/chains';

import { BASE_MAINNET } from '@zeus-evm/chain-config';

import { loadConfig } from './config';
import { logger } from './logger';
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
  client: AnyClient,
  state: MonitorState,
): Promise<void> {
  if (!env.THEGRAPH_API_KEY) {
    logger.warn('THEGRAPH_API_KEY não configurada — pulando discovery (modo on-chain only)');
    return;
  }

  try {
    logger.info('🔍 Discovery: buscando candidatos Aave V3 Base via subgraph (borrowedReservesCount > 0)...');
    const candidates = await fetchAllAaveV3Candidates({
      apiKey: env.THEGRAPH_API_KEY,
      subgraphId: env.AAVE_V3_BASE_SUBGRAPH_ID,
      maxUsers: 1000,
    });

    logger.info({ count: candidates.length }, `📋 ${candidates.length} candidatos com borrowedReservesCount > 0`);

    if (candidates.length === 0) return;

    // On-chain HF check — também traz debt/collateral EXATOS em USD (1e8 base)
    const users = candidates.map((c) => c.user);
    const accountDataList = await getUserAccountDataBatch(
      client,
      BASE_MAINNET.aave.pool,
      users,
      10,
    );

    // Filtrar dust: positions com debt < MIN_DEBT_USD não valem o gas mesmo se liquidáveis
    const minDebtBase = BigInt(Math.floor(env.MIN_DEBT_USD * 1e8));
    const withRealDebt = accountDataList.filter((u) => u.totalDebtBase >= minDebtBase);

    const atRisk = filterAtRisk(withRealDebt, env.HF_AT_RISK_THRESHOLD);
    logger.info(
      {
        candidates: candidates.length,
        scanned: accountDataList.length,
        withDebt: withRealDebt.length,
        atRisk: atRisk.length,
        threshold: env.HF_AT_RISK_THRESHOLD,
      },
      `🎯 ${withRealDebt.length} com debt ≥ $${env.MIN_DEBT_USD} (de ${accountDataList.length}); ${atRisk.length} em risco (HF < ${env.HF_AT_RISK_THRESHOLD})`,
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
  client: AnyClient,
  state: MonitorState,
): Promise<void> {
  if (state.positionsInRisk.size === 0) return;

  const users = Array.from(state.positionsInRisk.keys());
  const liquidatableThreshold = BigInt(Math.floor(env.HF_LIQUIDATABLE_THRESHOLD * 1e18));

  try {
    const accountDataList = await getUserAccountDataBatch(
      client,
      BASE_MAINNET.aave.pool,
      users,
      10,
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

  logger.info(
    {
      chain: BASE_MAINNET.name,
      subgraphId: env.AAVE_V3_BASE_SUBGRAPH_ID,
      hasApiKey: !!env.THEGRAPH_API_KEY,
      hfAtRisk: env.HF_AT_RISK_THRESHOLD,
      hfLiquidatable: env.HF_LIQUIDATABLE_THRESHOLD,
      minDebtUsd: env.MIN_DEBT_USD,
      minProfitUsd: env.MIN_LIQUIDATION_PROFIT_USD,
    },
    '🚀 Monitor boot (DRY_RUN mode)',
  );

  const client: AnyClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_HTTP),
  });

  const blockNumber = await client.getBlockNumber();
  logger.info({ blockNumber: blockNumber.toString() }, '✅ Conectado em Base mainnet');

  const state: MonitorState = {
    positionsInRisk: new Map(),
  };

  // ─── Discovery inicial ───
  await discoveryLoop(env, client, state);

  // ─── Loops periódicos ───
  setInterval(() => {
    discoveryLoop(env, client, state).catch((err) =>
      logger.error({ err }, 'discoveryLoop iteration failed'),
    );
  }, DISCOVERY_INTERVAL_MS);

  setInterval(() => {
    hfCheckLoop(env, client, state).catch((err) =>
      logger.error({ err }, 'hfCheckLoop iteration failed'),
    );
  }, HF_CHECK_INTERVAL_MS);

  await new Promise(() => {});
}

main().catch((err) => {
  logger.error({ err }, 'Monitor crashed at boot');
  process.exit(1);
});
