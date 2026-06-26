/**
 * Motor 2 / Filler UniswapX — avaliador (o cérebro). PURO e testável: dada uma ordem normalizada e uma
 * função de cotação (input→output), decide se vale preencher e quanto sobra de lucro.
 *
 * Modelo v1 (design simples): faz o sourcing de TODO o input → token de saída; lucro = saída do swap −
 * saída requerida (surplus), medido no token de SAÍDA. Honesto: pra long-tail volátil o lucro fica no
 * token de saída; um upgrade futuro (sourcing exact-output) deixa o surplus no token de ENTRADA (stable).
 * Atômico no contrato: se a conta não fechar on-chain, reverte (só gás).
 */

import type { Address } from 'viem';
import type { NormalizedOrder, FillEvaluation } from './types';

export interface EvaluateFillOpts {
  /** Cota o swap input→output (exact-input). Retorna a saída esperada (wei) ou null se sem rota. */
  quote: (tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<bigint | null>;
  /** Converte um amount do token em USD (stable=peg, WETH=×preço). null = sem preço. */
  estimateUsd: (token: Address, amountWei: bigint) => number | null;
  /** Lucro líquido mínimo em USD pra valer o fill. */
  minProfitUsd: number;
  /** Custo de gás estimado (USD) — descontado do lucro. */
  gasCostUsd: number;
  /** Agora (unix secs) — pra checar o deadline da ordem. */
  nowSec: number;
}

/** Soma as saídas por token; v1 só preenche ordens com 1 token de saída (caso dominante). */
function singleOutputToken(order: NormalizedOrder): { token: Address; amount: bigint } | null {
  if (order.outputs.length === 0) return null;
  const token = order.outputs[0]!.token.toLowerCase();
  let total = 0n;
  for (const o of order.outputs) {
    if (o.token.toLowerCase() !== token) return null; // múltiplos tokens de saída → skip v1
    total += o.amount;
  }
  return { token: order.outputs[0]!.token, amount: total };
}

export async function evaluateFill(order: NormalizedOrder, opts: EvaluateFillOpts): Promise<FillEvaluation> {
  // 1. Deadline (só checa quando conhecido; 0 = veio do filtro orderStatus=open, confia nele).
  if (order.deadline > 0 && order.deadline <= opts.nowSec) {
    return { ok: false, reason: 'ordem expirada (deadline passou)' };
  }

  // 2. Token de saída único (v1).
  const out = singleOutputToken(order);
  if (!out) return { ok: false, reason: 'múltiplos tokens de saída (v1 só single-output)' };
  if (out.amount === 0n) return { ok: false, reason: 'saída requerida zero' };
  if (order.input.amount === 0n) return { ok: false, reason: 'input zero' };

  // 3. Cota input → token de saída (sourcing de TODO o input).
  const swapOut = await opts.quote(order.input.token, out.token, order.input.amount);
  if (swapOut === null) return { ok: false, reason: 'sem rota de cotação (pool raso?)' };

  // 4. Lucro = surplus de saída acima do requerido.
  if (swapOut <= out.amount) {
    return { ok: false, reason: 'sourcing não cobre a saída requerida (sem surplus)', profitToken: out.token };
  }
  const profitWei = swapOut - out.amount;

  // 5. Lucro em USD − gás.
  const profitUsd = opts.estimateUsd(out.token, profitWei);
  if (profitUsd === null) {
    return { ok: false, reason: 'token de saída sem preço USD (v1 mira saídas valoráveis)', profitToken: out.token };
  }
  const netProfitUsd = profitUsd - opts.gasCostUsd;
  if (netProfitUsd < opts.minProfitUsd) {
    return {
      ok: false,
      reason: `lucro líquido $${netProfitUsd.toFixed(2)} < min $${opts.minProfitUsd}`,
      profitToken: out.token,
      profitWei,
    };
  }

  return {
    ok: true,
    profitToken: out.token,
    requiredOut: out.amount,
    expectedSwapOut: swapOut,
    profitWei,
    profitUsd: netProfitUsd,
    minProfitWei: (profitWei * 7n) / 10n, // 70% floor on-chain
  };
}
