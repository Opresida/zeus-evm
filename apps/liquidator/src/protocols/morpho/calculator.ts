/**
 * Morpho Blue — calculator de liquidation ótima + profit.
 *
 * Fluxo:
 *   1. planLiquidation (math.ts) decide repayAll vs seizeAll + seizedCollateral
 *   2. flashloan = repaidAssets (loanToken)
 *   3. swap seizedCollateral → loanToken (UniV3 quoter, single + multi-hop)
 *   4. profit = swapOutput − flashloan − premium(0.05%) − gas
 *   5. valida contra MIN_LIQUIDATION_PROFIT_USD
 *
 * Profit em wei do loanToken → USD via estimateUsd (stable=peg, WETH=×ethPrice).
 */

import type { Address, PublicClient } from 'viem';

import {
  quoteUniswapV3,
  quoteUniswapV3MultiHop,
  buildCandidateRoutes,
  bestSwapAcrossDexes,
  isQuote,
  type Quote,
} from '@zeus-evm/dex-adapters';
import type { ChainConfig } from '@zeus-evm/chain-config';
import { cachedQuoteUniswapV3, estimateUsd } from '@zeus-evm/execution-utils';
import { FlashSource } from '../../types';

import type { LiquidatorEnv } from '../../config';
import type { MorphoLiquidatablePosition, LiquidationDecision, SwapPlan } from '../../types';
import { planLiquidation, type LiquidationPlan } from './math';

type AnyPublicClient = PublicClient<any, any>;

const AAVE_FLASHLOAN_PREMIUM_BPS = 5n; // 0.05%
const BPS_DENOMINATOR = 10_000n;
const UNI_V3_FEE_TIERS = [500, 3000, 100, 10000];

export interface MorphoCalculatorOpts {
  env: LiquidatorEnv;
  client: AnyPublicClient;
  quoterAddress: Address;
  /** Chain config — habilita o swap multi-DEX (UniV3/Aero/Slipstream). Ausente = só UniV3 + multi-hop. */
  chainConfig?: ChainConfig;
  /** Intermediates pra multi-hop swap (WETH/USDC). Vazio = só single-hop. */
  multiHopIntermediates?: readonly Address[];
}

export interface MorphoLiquidationOutcome {
  ok: boolean;
  reason?: string;
  decision?: LiquidationDecision;
  plan?: LiquidationPlan;
  /** Swap output esperado em wei do loanToken (pra builder aplicar slippage). */
  expectedSwapOutputWei?: bigint;
}

/**
 * Cota o melhor swap collateral → loanToken (single + multi-hop).
 */
async function bestCollateralToLoanQuote(
  position: MorphoLiquidatablePosition,
  amountIn: bigint,
  opts: MorphoCalculatorOpts,
): Promise<Quote | null> {
  // Multi-DEX (single-hop UniV3/Aero/Slipstream) quando chainConfig presente. Substitui o multi-hop
  // legado (que NÃO era executável single-hop pelo contrato) — estimativa == execução + ganho LSD.
  if (opts.chainConfig) {
    return bestSwapAcrossDexes({
      client: opts.client,
      chainConfig: opts.chainConfig,
      tokenIn: position.collateralToken,
      tokenOut: position.loanToken,
      amountIn,
      decimalsIn: position.collateralTokenDecimals,
      decimalsOut: position.loanTokenDecimals,
    });
  }

  // Legado (sem chainConfig): UniV3 single-hop + multi-hop.
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

export async function calculateOptimalMorphoLiquidation(
  position: MorphoLiquidatablePosition,
  opts: MorphoCalculatorOpts,
): Promise<MorphoLiquidationOutcome> {
  const { env } = opts;

  // 1. Plano de liquidação (repayAll vs seizeAll)
  const plan = planLiquidation(
    { borrowShares: position.borrowShares, collateral: position.collateral },
    { totalBorrowAssets: position.totalBorrowAssets, totalBorrowShares: position.totalBorrowShares },
    position.collateralPrice,
    position.lltv,
  );
  if (!plan) {
    return { ok: false, reason: 'planLiquidation degenerou (sem colateral/dívida)' };
  }

  // 2. Swap quote: seizedCollateral → loanToken
  const quote = await bestCollateralToLoanQuote(position, plan.expectedSeizedCollateral, opts);
  if (!quote) {
    return { ok: false, reason: 'sem quote válida pro swap collateral→loan (pool raso?)' };
  }

  // 3. Profit = swapOutput − flashloan − premium − gas
  const flashloanFee = (plan.expectedRepaidAssets * AAVE_FLASHLOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
  // gas em USD → loanToken wei (aprox via estimateUsd inverso seria complexo; usamos
  // a estimativa direta: profit já em loanToken, comparamos USD no fim).
  const profitWei = quote.amountOut > plan.expectedRepaidAssets + flashloanFee
    ? quote.amountOut - plan.expectedRepaidAssets - flashloanFee
    : 0n;

  // Slippage do swap vs valor "ideal" (seizedCollateral em loanToken pelo oracle price)
  // idealOut = seizedCollateral × price / 1e36 (em loanToken wei, ajustado por decimals já no price)
  const idealOut = (plan.expectedSeizedCollateral * position.collateralPrice) / (10n ** 36n);
  const slippageBps = idealOut > quote.amountOut && idealOut > 0n
    ? Number(((idealOut - quote.amountOut) * BPS_DENOMINATOR) / idealOut)
    : 0;
  if (slippageBps > env.MAX_SLIPPAGE_BPS) {
    return { ok: false, reason: `slippage ${slippageBps}bps > MAX ${env.MAX_SLIPPAGE_BPS}` };
  }

  // 4. Profit USD via estimateUsd (loanToken: stable=peg, WETH=×ethPrice)
  const profitUsd = estimateUsd(
    position.loanTokenSymbol,
    profitWei,
    position.loanTokenDecimals,
    env.ETH_USD_PRICE_ESTIMATE,
  ) ?? 0;

  // Desconta gas estimado (USD) do profit USD
  const netProfitUsd = profitUsd - env.GAS_COST_USD_ESTIMATE;
  if (netProfitUsd < env.MIN_LIQUIDATION_PROFIT_USD) {
    return {
      ok: false,
      reason: `profit líquido $${netProfitUsd.toFixed(2)} < threshold $${env.MIN_LIQUIDATION_PROFIT_USD}`,
    };
  }

  // Multi-DEX: o `quote` já é o melhor venue single-hop (quando chainConfig presente) e carrega
  // router/dex/extraData → vira o swapPlan executável. Legado (UniV3) não tem router → fallback no builder.
  const swapPlan: SwapPlan | undefined = quote.router
    ? { dexType: quote.dex as number, router: quote.router, extraData: quote.extraData, expectedOutput: quote.amountOut }
    : undefined;

  const decision: LiquidationDecision = {
    flashloanAmount: plan.expectedRepaidAssets,
    expectedProfitWei: profitWei,
    expectedProfitUsd: netProfitUsd,
    estimatedSlippageBps: slippageBps,
    minProfitWei: (profitWei * 7n) / 10n, // 70% floor (margem segurança)
    // Default Aave; pipeline sobrescreve via seletor (Morpho 0% é o ganho óbvio aqui).
    flashSource: FlashSource.Aave,
    flashPremiumBps: AAVE_FLASHLOAN_PREMIUM_BPS,
    swapPlan,
  };

  return { ok: true, decision, plan, expectedSwapOutputWei: quote.amountOut };
}
