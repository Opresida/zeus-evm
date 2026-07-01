/**
 * Funding/sweep planner (cuidado #3 do Humberto) — PLANEJA o gás dos N EOAs e a varredura do que sobra.
 *
 * Estratégia de lucro: o `profitReceiver` da pré-liquidação é um TESOURO único (não cada sender) →
 * o lucro já consolida sozinho, sem precisar varrer token. O que cada EOA precisa é de ETH pra GÁS.
 *
 * Estas funções são PURAS (só calculam o plano). A execução real (enviar ETH do tesouro pros EOAs,
 * varrer ETH ocioso de volta) é da fase mainnet — aqui não movemos fundo nenhum.
 */

import type { Address } from 'viem';

export interface GasTopUp {
  address: Address;
  /** Quanto enviar (wei) pra levar o saldo de volta ao alvo. */
  amountWei: bigint;
}

export interface GasSweep {
  address: Address;
  /** Quanto varrer de volta pro tesouro (wei), mantendo o buffer. */
  amountWei: bigint;
}

/**
 * Planeja top-ups de gás: todo EOA com saldo < minWei é reabastecido ATÉ targetWei.
 * @param balances saldo ETH (wei) por endereço.
 * @param minWei gatilho — abaixo disso, reabastece.
 * @param targetWei alvo pós-reabastecimento (deve ser ≥ minWei).
 */
export function planGasTopUps(
  balances: Map<Address, bigint>,
  minWei: bigint,
  targetWei: bigint,
): GasTopUp[] {
  if (targetWei < minWei) throw new Error('planGasTopUps: targetWei deve ser ≥ minWei');
  const out: GasTopUp[] = [];
  for (const [address, bal] of balances) {
    if (bal < minWei) out.push({ address, amountWei: targetWei - bal });
  }
  return out;
}

/**
 * Planeja varredura de gás ocioso (ex: ao desativar o pool): todo EOA com saldo > keepWei
 * devolve o excedente pro tesouro, mantendo `keepWei` de buffer.
 */
export function planGasSweeps(balances: Map<Address, bigint>, keepWei: bigint): GasSweep[] {
  const out: GasSweep[] = [];
  for (const [address, bal] of balances) {
    if (bal > keepWei) out.push({ address, amountWei: bal - keepWei });
  }
  return out;
}

/** Total de ETH (wei) necessário pra um conjunto de top-ups — pra checar se o tesouro cobre. */
export function totalTopUpWei(topUps: GasTopUp[]): bigint {
  return topUps.reduce((acc, t) => acc + t.amountWei, 0n);
}
