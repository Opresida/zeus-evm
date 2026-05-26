/**
 * Stale Position Re-check — antes do dispatch, confirma se borrower ainda é liquidável.
 *
 * Cenário do problema:
 *   1. Tick T: discovery detecta borrower X com HF=0.95 (liquidatable)
 *   2. Pipeline executa: calculator (~500ms) + simulator (~100ms) + builder (~10ms)
 *   3. Total: ~600-1000ms entre detecção e submit
 *   4. Nesse intervalo, OUTRO BOT liquida X
 *   5. Nosso submit reverte porque X não é mais liquidatable
 *   6. Gas perdido (~$0.20-0.50 em Base)
 *
 * Solução: ~50ms de chamada RPC extra pra re-checar HF logo antes do submit.
 * Se não estiver mais liquidable, aborta sem queimar gas.
 *
 * Trade-off: +50ms latência por dispatch real. Vale a pena porque:
 *   - Gas perdido por race condition é ~50% mais caro que esses 50ms vs perder oportunidade
 *   - Em mainnet, race condition é COMUM (bots top têm latência <100ms)
 *
 * Aave V3: getUserAccountData retorna healthFactor — comparar com threshold.
 * Compound III: isLiquidatable retorna boolean — definitivo.
 * Morpho Blue: Sprint 3 pendente, será adicionado quando pipeline TS estiver pronto.
 */

import type { Address, PublicClient } from 'viem';
import { POOL_ABI } from '@zeus-evm/aave-discovery';

import type { LoggerLike } from '@zeus-evm/aave-discovery';

type AnyPublicClient = PublicClient<any, any>;

const COMET_IS_LIQUIDATABLE_ABI = [
  {
    type: 'function',
    name: 'isLiquidatable',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

export interface StaleCheckResult {
  stillLiquidatable: boolean;
  /** Razão se stale (pra log/event). */
  reason?: string;
  /** Métricas opcionais. */
  healthFactor?: bigint;
  /** Latência da check em ms. */
  elapsedMs: number;
}

/**
 * Pra Aave V3: getUserAccountData + comparar healthFactor com threshold.
 * threshold default 1.0 (1e18 em wei).
 */
export async function isAaveStillLiquidatable(opts: {
  client: AnyPublicClient;
  poolAddress: Address;
  borrower: Address;
  /** HF threshold (default 1.0 = 1e18). Liquidatable se HF < threshold. */
  hfThresholdWei?: bigint;
  logger?: LoggerLike;
}): Promise<StaleCheckResult> {
  const { client, poolAddress, borrower, hfThresholdWei = 10n ** 18n, logger } = opts;
  const start = Date.now();

  try {
    const data = (await client.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'getUserAccountData',
      args: [borrower],
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

    // [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor]
    const healthFactor = data[5];
    const elapsedMs = Date.now() - start;

    // HF = 0 significa "sem debt" no Aave V3 — não liquidable
    if (healthFactor === 0n) {
      return {
        stillLiquidatable: false,
        reason: 'HF=0 (sem debt — position já foi liquidada/repaga)',
        healthFactor,
        elapsedMs,
      };
    }

    const stillLiquidatable = healthFactor < hfThresholdWei;
    return {
      stillLiquidatable,
      reason: stillLiquidatable
        ? undefined
        : `HF ${(Number(healthFactor) / 1e18).toFixed(4)} >= threshold ${(Number(hfThresholdWei) / 1e18).toFixed(2)}`,
      healthFactor,
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    logger?.warn(
      { borrower, err: err instanceof Error ? err.message : err, elapsedMs },
      `Stale check Aave falhou — assumindo ainda liquidable (fail-open)`,
    );
    // Fail-open: se RPC falhar, assume ainda liquidable e prossegue (não bloqueia oportunidade)
    return {
      stillLiquidatable: true,
      reason: 'RPC error — assumed liquidable',
      elapsedMs,
    };
  }
}

/**
 * Pra Compound III: isLiquidatable é definitivo — chama direto.
 */
export async function isCompoundStillLiquidatable(opts: {
  client: AnyPublicClient;
  comet: Address;
  borrower: Address;
  logger?: LoggerLike;
}): Promise<StaleCheckResult> {
  const { client, comet, borrower, logger } = opts;
  const start = Date.now();

  try {
    const stillLiquidatable = (await client.readContract({
      address: comet,
      abi: COMET_IS_LIQUIDATABLE_ABI,
      functionName: 'isLiquidatable',
      args: [borrower],
    })) as boolean;
    const elapsedMs = Date.now() - start;

    return {
      stillLiquidatable,
      reason: stillLiquidatable ? undefined : 'Comet.isLiquidatable() = false (position resolved)',
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    logger?.warn(
      { borrower, comet, err: err instanceof Error ? err.message : err, elapsedMs },
      `Stale check Compound falhou — assumindo ainda liquidable (fail-open)`,
    );
    return {
      stillLiquidatable: true,
      reason: 'RPC error — assumed liquidable',
      elapsedMs,
    };
  }
}
