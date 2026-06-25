/**
 * resolveBestSwapPlan — escolhe a melhor DEX (UniV3/Aero/Slipstream) pra a troca colateral→dívida
 * de uma liquidação, no tamanho ótimo já decidido pelo sizing.
 *
 * Compartilhado pelos 4 protocolos (Aave/Compound/Morpho/Moonwell) — todos fazem o mesmo passo:
 * recebem colateral, trocam por dívida, devolvem o flashloan (+ premium). O sizing roda em UniV3
 * (proxy barato); aqui, UMA vez no amount escolhido, cotamos todas as DEX e pegamos a melhor.
 *
 * Fail-safe: qualquer erro de cotação → `swapPlan` indefinido (builder cai no UniV3 legado) e o
 * profit fica o do sizing. Nunca piora: `profit = max(priorProfit, profit do melhor venue)`.
 */

import type { Address, PublicClient } from 'viem';
import { bestSwapAcrossDexes } from '@zeus-evm/dex-adapters';
import type { ChainConfig } from '@zeus-evm/chain-config';
import type { SwapPlan } from '../types';

type AnyPublicClient = PublicClient<any, any>;

export interface BestSwapPlanInput {
  client: AnyPublicClient;
  /** Ausente → pula o multi-DEX (mantém fallback UniV3). */
  chainConfig?: ChainConfig;
  collateralAsset: Address;
  debtAsset: Address;
  collateralDecimals: number;
  debtDecimals: number;
  /** Quantidade de colateral a trocar (wei) — amountIn do swap. */
  collateralAmount: bigint;
  /** Quanto devolver ao flashloan em wei do debtAsset (principal + premium). */
  repayAmount: bigint;
  /** Custo de gás estimado em wei do debtAsset. */
  gasCostWei: bigint;
  /** Profit estimado pelo sizing (UniV3) — piso. */
  priorProfit: bigint;
}

export interface BestSwapPlanResult {
  swapPlan?: SwapPlan;
  /** max(priorProfit, profit recalculado com o melhor venue). */
  profit: bigint;
}

/**
 * Nome legível da DEX a partir do `dexType` do swapPlan — pra observabilidade (evento tx.confirmed
 * → painel "trocou via X"). Sem swapPlan (fallback) = uniswap-v3.
 */
export function swapVenueLabel(dexType?: number): string {
  switch (dexType) {
    case 2:
      return 'aerodrome';
    case 5:
      return 'slipstream';
    default:
      return 'uniswap-v3'; // 1 (UniV3) ou ausente (fallback legado)
  }
}

export async function resolveBestSwapPlan(input: BestSwapPlanInput): Promise<BestSwapPlanResult> {
  const { client, chainConfig, collateralAmount, repayAmount, gasCostWei, priorProfit } = input;
  if (!chainConfig || collateralAmount <= 0n) return { profit: priorProfit };

  try {
    const q = await bestSwapAcrossDexes({
      client,
      chainConfig,
      tokenIn: input.collateralAsset,
      tokenOut: input.debtAsset,
      amountIn: collateralAmount,
      decimalsIn: input.collateralDecimals,
      decimalsOut: input.debtDecimals,
    });
    if (!q || !q.router) return { profit: priorProfit };

    const venueProfit = q.amountOut > repayAmount + gasCostWei ? q.amountOut - repayAmount - gasCostWei : 0n;
    return {
      swapPlan: {
        dexType: q.dex as number,
        router: q.router,
        extraData: q.extraData,
        expectedOutput: q.amountOut,
      },
      profit: venueProfit > priorProfit ? venueProfit : priorProfit,
    };
  } catch {
    // Fan-out falhou → fallback UniV3 (sem swapPlan), profit do sizing.
    return { profit: priorProfit };
  }
}
