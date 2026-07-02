/**
 * #12 automação — Wallet-pool rebalance (observe-first).
 *
 * Quando o wallet-pool está ativo (mainnet/armado), as N carteiras gastam gás em ritmos diferentes: umas
 * esvaziam, outras sobram. Este advisor reusa os planners `planGasTopUps`/`planGasSweeps` (funding.ts) pra
 * mostrar "reabasteceria a carteira A com X ETH / varreria o excesso de B" — SEM mover nada. A execução real
 * do plano é uma decisão humana (mexe dinheiro real). Em DRY_RUN o pool nem existe → o advisor fica omitido
 * (honesto: é feature de execução, cinza no dryrun, igual o canário do wallet-pool).
 *
 * Não inventa sinal: recebe os saldos que o caller leu on-chain das próprias EOAs do pool.
 */

import type { Address } from 'viem';
import { planGasTopUps, planGasSweeps, totalTopUpWei } from '../walletPool/funding';

export interface WalletRebalancePlan {
  senders: number;
  /** Nº de carteiras abaixo do piso (precisam de gás). */
  belowFloor: number;
  /** Total a reabastecer (ETH) somando os top-ups. */
  topUpEth: number;
  /** Nº de carteiras com excesso varrível. */
  withExcess: number;
  /** Precisa rebalancear? (algum top-up ou sweep sugerido). */
  needsRebalance: boolean;
  /** Resumo PT-BR pro painel. */
  summary: string;
}

const WEI_PER_ETH = 1_000_000_000_000_000_000n;

function weiToEth(wei: bigint): number {
  return Number(wei / 1_000_000_000n) / 1e9;
}

/**
 * Computa o plano de rebalance a partir dos saldos on-chain das EOAs do pool.
 * @param balances  saldo (wei) por endereço das carteiras do pool.
 * @param minWei    piso: abaixo disso a carteira é reabastecida.
 * @param targetWei alvo pós-reabastecimento.
 * @param sweepAboveWei  varre o que passar disso de volta pro tesouro (opcional).
 */
export function computeWalletRebalance(
  balances: Map<Address, bigint>,
  opts: { minWei: bigint; targetWei: bigint; sweepAboveWei?: bigint },
): WalletRebalancePlan {
  const topUps = planGasTopUps(balances, opts.minWei, opts.targetWei);
  const sweeps = opts.sweepAboveWei != null
    ? planGasSweeps(balances, opts.sweepAboveWei) // varre o que passar do "keep" (= sweepAboveWei)
    : [];
  const topUpWei = totalTopUpWei(topUps);
  const topUpEth = weiToEth(topUpWei);
  const needsRebalance = topUps.length > 0 || sweeps.length > 0;
  const summary = needsRebalance
    ? `${topUps.length} carteira(s) abaixo do piso (${topUpEth.toFixed(4)} ETH p/ reabastecer)` +
      (sweeps.length ? ` · ${sweeps.length} com excesso varrível` : '')
    : 'pool equilibrado — sem rebalance';
  return {
    senders: balances.size,
    belowFloor: topUps.length,
    topUpEth,
    withExcess: sweeps.length,
    needsRebalance,
    summary,
  };
}

export { WEI_PER_ETH };
