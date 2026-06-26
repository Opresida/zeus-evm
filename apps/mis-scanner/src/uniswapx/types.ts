/**
 * Motor 2 / Filler UniswapX — tipos normalizados.
 *
 * A API da UniswapX entrega as ordens já DECODIFICADAS (input/output + amounts em JSON) — o feed só
 * mapeia pra este formato. O avaliador trabalha em cima dele (puro, sem rede).
 */

import type { Address, Hex } from 'viem';

/** Uma saída da ordem (o que o swapper quer receber). */
export interface OrderOutput {
  token: Address;
  /** Amount ATUAL (já considerando o decaimento do leilão holandês) em wei do token. */
  amount: bigint;
  recipient: Address;
}

/** Ordem UniswapX normalizada (pós-decode do feed). */
export interface NormalizedOrder {
  reactor: Address;
  orderHash: Hex;
  swapper: Address;
  /** Token + amount que o swapper ENTREGA (nosso input pro sourcing). */
  input: { token: Address; amount: bigint };
  /** Saídas que devemos produzir (≥). 1+ — somamos por token. */
  outputs: OrderOutput[];
  /** Deadline (unix secs). 0 = desconhecido (ordem veio do filtro orderStatus=open → confiar nele). */
  deadline: number;
  /** Filler exclusivo (cosignerData). Se setado e != nós, não dá pra preencher na janela de exclusividade. */
  exclusiveFiller?: Address;
  /** Blob assinado pra passar no executeFill (order bytes + assinatura EIP-712). */
  signedOrder: Hex;
  signature: Hex;
}

/** Resultado da avaliação de uma ordem (preencher ou não + economia). */
export interface FillEvaluation {
  ok: boolean;
  reason?: string;
  /** Token onde medimos/ficamos com o surplus. */
  profitToken?: Address;
  /** Saída requerida total no profitToken (o que o reactor vai puxar). */
  requiredOut?: bigint;
  /** Saída esperada do swap input→profitToken (do quoter). */
  expectedSwapOut?: bigint;
  /** Lucro esperado (surplus) em wei do profitToken. */
  profitWei?: bigint;
  profitUsd?: number;
  /** Floor on-chain (minProfitWei) = 70% do esperado. */
  minProfitWei?: bigint;
}
