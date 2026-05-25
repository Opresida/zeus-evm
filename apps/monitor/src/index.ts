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
import { scanCompoundLiquidatable } from './protocols/compoundV3';
import { fetchMorphoPositions } from './protocols/morpho';
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

/**
 * Compound III discovery + check em paralelo ao Aave.
 * Scan eventos `Withdraw` recentes + isLiquidatable() via Multicall3.
 */
async function compoundDiscoveryLoop(ctx: ChainContext): Promise<void> {
  const compound = ctx.chainConfig.compoundV3;
  if (!compound) {
    return; // chain sem Compound III configurado
  }

  const markets: { name: string; address: Address }[] = [];
  if (compound.cUSDCv3 && compound.cUSDCv3 !== '0x0000000000000000000000000000000000000000') {
    markets.push({ name: 'cUSDCv3', address: compound.cUSDCv3 as Address });
  }
  if (compound.cWETHv3 && compound.cWETHv3 !== '0x0000000000000000000000000000000000000000') {
    markets.push({ name: 'cWETHv3', address: compound.cWETHv3 as Address });
  }

  if (markets.length === 0) return;

  for (const market of markets) {
    try {
      const { totalBorrowers, liquidatable } = await scanCompoundLiquidatable({
        client: ctx.client,
        comet: market.address,
        blockLookback: 100_000, // ~28h Base / ~5.5h Arb (block times diferentes)
      });

      logger.info(
        {
          chain: ctx.chainConfig.name,
          market: market.name,
          comet: market.address,
          activeBorrowers: totalBorrowers,
          liquidatable: liquidatable.length,
        },
        `📊 [${ctx.chainConfig.shortName}/${market.name}] ${totalBorrowers} borrowers ativos · ${liquidatable.length} liquidáveis`,
      );

      // Loga primeiros 3 liquidáveis (se houver)
      for (const liq of liquidatable.slice(0, 3)) {
        logger.warn(
          { chain: ctx.chainConfig.name, market: market.name, borrower: liq.borrower },
          `🔥 LIQUIDÁVEL Compound: ${liq.borrower.slice(0, 10)}... em ${market.name}`,
        );
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err, market: market.name },
        `Compound discovery falhou pra ${market.name}`,
      );
    }
  }
}

/**
 * Morpho Blue discovery — só em Base (única chain com volume real em 2026).
 * Lista positions com debt > 0 via subgraph oficial Morpho.
 */
async function morphoDiscoveryLoop(
  env: ReturnType<typeof loadConfig>,
  ctx: ChainContext,
): Promise<void> {
  // Morpho ativo apenas em Base mainnet
  if (ctx.chainConfig.chainId !== 8453) return;

  if (!env.THEGRAPH_API_KEY) {
    return; // discovery requer API key
  }

  try {
    const positions = await fetchMorphoPositions({
      apiKey: env.THEGRAPH_API_KEY,
      subgraphId: env.MORPHO_BLUE_BASE_SUBGRAPH_ID,
      first: 200,
    });

    // Filtra por debt mínimo (em wei do loanToken, depende do token — aprox $100 em USDC = 100e6)
    // Simplificação: filtrar positions com borrowAmount > 100 USDC equivalent (assume USDC base 6 decimals)
    const minBorrowUsdc6 = BigInt(env.MIN_DEBT_USD * 1_000_000);
    const significant = positions.filter((p) => p.borrowAmount >= minBorrowUsdc6);

    logger.info(
      {
        chain: ctx.chainConfig.name,
        totalPositions: positions.length,
        significantPositions: significant.length,
        minDebtUsd: env.MIN_DEBT_USD,
      },
      `📊 [${ctx.chainConfig.shortName}/morpho] ${positions.length} positions ativas · ${significant.length} acima de $${env.MIN_DEBT_USD}`,
    );

    // Loga top 3 positions maiores (potencialmente liquidáveis)
    for (const p of significant.slice(0, 3)) {
      logger.info(
        {
          chain: ctx.chainConfig.name,
          borrower: p.borrower,
          marketId: p.marketId,
          loanToken: p.marketParams.loanToken,
          collateralToken: p.marketParams.collateralToken,
          borrowAmount: p.borrowAmount.toString(),
        },
        `  📌 Morpho position ${p.borrower.slice(0, 10)}... loan=${p.marketParams.loanToken.slice(0, 10)} debt=${p.borrowAmount.toString()}`,
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      'Morpho discovery falhou',
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

  // ─── Discovery inicial (Aave V3 + Compound III + Morpho Blue) ───
  await discoveryLoop(env, ctx, state);
  await compoundDiscoveryLoop(ctx);
  await morphoDiscoveryLoop(env, ctx);

  // ─── Loops periódicos ───
  setInterval(() => {
    discoveryLoop(env, ctx, state).catch((err) =>
      logger.error({ err }, 'discoveryLoop iteration failed'),
    );
  }, DISCOVERY_INTERVAL_MS);

  setInterval(() => {
    compoundDiscoveryLoop(ctx).catch((err) =>
      logger.error({ err }, 'compoundDiscoveryLoop iteration failed'),
    );
  }, DISCOVERY_INTERVAL_MS);

  setInterval(() => {
    morphoDiscoveryLoop(env, ctx).catch((err) =>
      logger.error({ err }, 'morphoDiscoveryLoop iteration failed'),
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
