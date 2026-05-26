/**
 * Cálculo off-chain do `minBribeWei` para proteger swap inline da BribeManager
 * contra sandwich attacks.
 *
 * Contexto: Audit Pass 4 fix H-01 fez BribeManager.pay usar
 * `amountOutMinimum = bribe.minBribeWei` no swap UniV3. Quando o bot off-chain
 * envia `minBribeWei = 0` (caso comum se tratado apenas como "floor econômico"),
 * o fix fica DESATIVADO e o swap aceita qualquer retorno — abrindo sandwich.
 *
 * Este helper resolve calculando off-chain via Quoter V2 o WETH esperado do swap,
 * aplicando tolerância de slippage, e usando o resultado como floor real.
 *
 * Caller deve combinar este floor com qualquer outro floor que ele já tenha
 * (ex: backrun-engine combina com floor USD por gasWarLevel) via max(...).
 */

import type { Address, PublicClient } from 'viem';
import { quoteUniswapV3 } from '@zeus-evm/dex-adapters';

type AnyPublicClient = PublicClient<any, any>;

export interface BribeSlippageFloorParams {
  client: AnyPublicClient;
  quoterAddress: Address;
  /** Endereço do WETH (canônico da chain). */
  weth: Address;
  /** Token onde o profit acumula (debt asset em liquidations, profit token em arb). */
  profitToken: Address;
  /** Profit esperado em unidades do profitToken (vem do calculator/simulator). */
  expectedProfitWei: bigint;
  /** % do profit que vai pra bribe (bps). Bate com `bribeBps` no BribeConfig. */
  bribeBps: bigint;
  /** Fee tier do pool profitToken/WETH (ex: 500 = 0.05%). */
  swapFeeTier: number;
  /** Tolerância de slippage em bps (ex: 100 = 1%). Recomendado 100-200. */
  slippageBps: bigint;
  /** Decimals do profitToken (necessário pro quoter). */
  profitTokenDecimals: number;
}

export type BribeSlippageFloorResult =
  | { ok: true; minBribeWei: bigint; quotedWeth: bigint; bribeProfitTarget: bigint }
  | { ok: false; reason: string };

const WETH_DECIMALS = 18;
const BPS = 10_000n;

/**
 * Calcula o floor de slippage off-chain para o swap inline da BribeManager.
 *
 * Quando `profitToken == weth`:
 *   Fast path (sem swap). Retorna `minBribeWei = 0` — o campo só serve como
 *   piso econômico nesse caso, não slippage protection.
 *
 * Quando `profitToken != weth`:
 *   1. bribeProfitTarget = expectedProfitWei × bribeBps / 10000
 *   2. Quote: profitToken → WETH via UniV3 Quoter V2
 *   3. minBribeWei = quote × (10000 − slippageBps) / 10000
 *
 * Quando o quote falha (sem liquidez no pool, par inexistente): retorna
 * `ok: false` para o caller decidir abortar bribe em vez de submeter inseguro.
 */
export async function computeBribeSlippageFloor(
  params: BribeSlippageFloorParams,
): Promise<BribeSlippageFloorResult> {
  const {
    client,
    quoterAddress,
    weth,
    profitToken,
    expectedProfitWei,
    bribeBps,
    swapFeeTier,
    slippageBps,
    profitTokenDecimals,
  } = params;

  if (expectedProfitWei <= 0n) {
    return { ok: false, reason: 'expectedProfitWei <= 0' };
  }
  if (bribeBps <= 0n) {
    return { ok: false, reason: 'bribeBps <= 0' };
  }
  if (slippageBps >= BPS) {
    return { ok: false, reason: `slippageBps ${slippageBps} >= 10000 (sem proteção)` };
  }

  const bribeProfitTarget = (expectedProfitWei * bribeBps) / BPS;
  if (bribeProfitTarget === 0n) {
    return { ok: false, reason: 'bribeProfitTarget = 0 após arredondamento' };
  }

  // Fast path: profitToken == WETH → BribeManager NÃO faz swap.
  // minBribeWei serve só como floor econômico aqui (não slippage). Caller pode
  // setar 0n com segurança ou aplicar seu próprio floor USD.
  if (profitToken.toLowerCase() === weth.toLowerCase()) {
    return { ok: true, minBribeWei: 0n, quotedWeth: bribeProfitTarget, bribeProfitTarget };
  }

  const quoteResult = await quoteUniswapV3({
    client,
    quoterAddress,
    tokenIn: profitToken,
    tokenOut: weth,
    amountIn: bribeProfitTarget,
    fee: swapFeeTier,
    decimalsIn: profitTokenDecimals,
    decimalsOut: WETH_DECIMALS,
  });

  if (!('amountOut' in quoteResult)) {
    return {
      ok: false,
      reason: `quote falhou: ${quoteResult.reason ?? 'unknown'}`,
    };
  }

  const quotedWeth = quoteResult.amountOut;
  // floor = quote × (1 − slippage)
  const minBribeWei = (quotedWeth * (BPS - slippageBps)) / BPS;

  if (minBribeWei === 0n) {
    return { ok: false, reason: 'minBribeWei calculado = 0 (quote ínfimo ou slippage 100%)' };
  }

  return { ok: true, minBribeWei, quotedWeth, bribeProfitTarget };
}
