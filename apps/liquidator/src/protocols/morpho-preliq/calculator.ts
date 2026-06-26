/**
 * Morpho PRE-liquidation — calculator de fatia ótima + profit.
 *
 * Diferença-chave vs liquidação clássica: **NÃO há flashloan**. O contrato PreLiquidation
 * adianta o colateral pelo callback `onPreLiquidate`; nosso contrato vende esse colateral →
 * loanToken e devolve `repaidAssets`. Logo:
 *
 *   profit = swapOutput(colateral seizado → loanToken) − repaidAssets   (zero fee de flashloan)
 *
 * Fluxo:
 *   1. planPreLiquidation (math.ts) → repaidShares/seizedAssets/repaidAssets (espelha o contrato)
 *   2. swap quote: seizedCollateral → loanToken (UniV3 quoter single + multi-hop)
 *   3. profit = swapOutput − repaidAssets − gas
 *   4. valida slippage e MIN_LIQUIDATION_PROFIT_USD
 *
 * Lucro SEMPRE em loanToken (stable) — a doutrina é callback+swap, nunca inventário.
 */

import type { Address, PublicClient } from 'viem';

import {
  quoteUniswapV3,
  quoteUniswapV3MultiHop,
  buildCandidateRoutes,
  isQuote,
  type Quote,
} from '@zeus-evm/dex-adapters';
import { cachedQuoteUniswapV3, estimateUsd } from '@zeus-evm/execution-utils';

import type { LiquidatorEnv } from '../../config';
import { planPreLiquidation, ORACLE_PRICE_SCALE, type PrePlan } from './math';
import type { PrePosition } from './types';

type AnyPublicClient = PublicClient<any, any>;

const UNI_V3_FEE_TIERS = [500, 3000, 100, 10000];

export interface PreLiquidationCalculatorOpts {
  env: LiquidatorEnv;
  client: AnyPublicClient;
  quoterAddress: Address;
  /** Intermediates pra multi-hop swap (WETH/USDC). Vazio = só single-hop. */
  multiHopIntermediates?: readonly Address[];
}

export interface PreLiquidationOutcome {
  ok: boolean;
  reason?: string;
  plan?: PrePlan;
  /** Melhor rota de swap (colateral → loanToken) pro builder traduzir em SwapStep[]. */
  quote?: Quote;
  /** Swap output esperado em wei do loanToken (pra builder aplicar slippage → minAmountOut). */
  expectedSwapOutputWei?: bigint;
  /** Profit líquido estimado (loanToken wei) e USD. */
  expectedProfitWei?: bigint;
  expectedProfitUsd?: number;
  /** Floor on-chain (minProfitWei) — 70% do profit esperado. */
  minProfitWei?: bigint;
  estimatedSlippageBps?: number;
}

/** Cota o melhor swap collateral → loanToken (single + multi-hop). Reusa o padrão do Morpho clássico. */
async function bestCollateralToLoanQuote(
  position: PrePosition,
  amountIn: bigint,
  opts: PreLiquidationCalculatorOpts,
): Promise<Quote | null> {
  let best: Quote | null = null;

  for (const fee of UNI_V3_FEE_TIERS) {
    const q = await cachedQuoteUniswapV3(
      {
        client: opts.client,
        quoterAddress: opts.quoterAddress,
        tokenIn: position.collateralToken,
        tokenOut: position.loanToken,
        amountIn,
        fee,
        decimalsIn: position.collateralTokenDecimals,
        decimalsOut: position.loanTokenDecimals,
      },
      quoteUniswapV3,
    );
    if (isQuote(q) && (!best || q.amountOut > best.amountOut)) best = q;
  }

  if (opts.multiHopIntermediates && opts.multiHopIntermediates.length > 0) {
    const routes = buildCandidateRoutes({
      tokenIn: position.collateralToken,
      tokenOut: position.loanToken,
      intermediates: opts.multiHopIntermediates,
      maxRoutes: 9,
    }).filter((r) => r.tokens.length > 2);
    for (const route of routes) {
      const q = await quoteUniswapV3MultiHop({
        client: opts.client,
        quoterAddress: opts.quoterAddress,
        route,
        amountIn,
        decimalsIn: position.collateralTokenDecimals,
        decimalsOut: position.loanTokenDecimals,
      });
      if (isQuote(q) && (!best || q.amountOut > best.amountOut)) best = q;
    }
  }

  return best;
}

export async function calculateOptimalPreLiquidation(
  position: PrePosition,
  opts: PreLiquidationCalculatorOpts,
): Promise<PreLiquidationOutcome> {
  const { env } = opts;

  // 1. Plano de pré-liquidação (faixa pre + preLIF/preLCF + fatia máxima dentro do close factor).
  const plan = planPreLiquidation(
    { borrowShares: position.borrowShares, collateral: position.collateral },
    { totalBorrowAssets: position.totalBorrowAssets, totalBorrowShares: position.totalBorrowShares },
    position.collateralPrice,
    position.config,
  );
  if (!plan) {
    return { ok: false, reason: 'planPreLiquidation: fora da faixa pre ou math degenerou' };
  }

  // 2. Swap quote: seizedCollateral → loanToken.
  const quote = await bestCollateralToLoanQuote(position, plan.expectedSeizedCollateral, opts);
  if (!quote) {
    return { ok: false, reason: 'sem quote válida pro swap collateral→loan (pool raso?)', plan };
  }

  // 3. Profit = swapOutput − repaidAssets (SEM fee de flashloan — colateral adiantado pelo callback).
  const profitWei = quote.amountOut > plan.expectedRepaidAssets ? quote.amountOut - plan.expectedRepaidAssets : 0n;

  // Slippage do swap vs ideal (seizedCollateral em loanToken pelo oracle da pré-liq).
  const idealOut = (plan.expectedSeizedCollateral * position.collateralPrice) / ORACLE_PRICE_SCALE;
  const slippageBps =
    idealOut > quote.amountOut && idealOut > 0n
      ? Number(((idealOut - quote.amountOut) * 10_000n) / idealOut)
      : 0;
  if (slippageBps > env.MAX_SLIPPAGE_BPS) {
    return { ok: false, reason: `slippage ${slippageBps}bps > MAX ${env.MAX_SLIPPAGE_BPS}`, plan, quote };
  }

  // 4. Profit USD (loanToken: stable=peg, WETH=×ethPrice) − gas.
  const profitUsd =
    estimateUsd(position.loanTokenSymbol, profitWei, position.loanTokenDecimals, env.ETH_USD_PRICE_ESTIMATE) ?? 0;
  const netProfitUsd = profitUsd - env.GAS_COST_USD_ESTIMATE;
  if (netProfitUsd < env.MIN_LIQUIDATION_PROFIT_USD) {
    return {
      ok: false,
      reason: `profit líquido $${netProfitUsd.toFixed(2)} < threshold $${env.MIN_LIQUIDATION_PROFIT_USD}`,
      plan,
      quote,
    };
  }

  return {
    ok: true,
    plan,
    quote,
    expectedSwapOutputWei: quote.amountOut,
    expectedProfitWei: profitWei,
    expectedProfitUsd: netProfitUsd,
    minProfitWei: (profitWei * 7n) / 10n, // 70% floor (margem de segurança vs slippage real)
    estimatedSlippageBps: slippageBps,
  };
}
