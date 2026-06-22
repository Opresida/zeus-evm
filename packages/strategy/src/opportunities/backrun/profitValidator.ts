/**
 * profitValidator — valida BackrunOpportunity via simulação on-chain.
 *
 * Fluxo:
 *   1. Recebe BackrunOpportunity (do planner) + params do executor
 *   2. Encoda calldata pra executeFlashloanArbitrage usando o flashloan path
 *   3. Roda eth_call (simulateArbitrage)
 *   4. Subtrai gas estimado + flashloan fee → retorna net profit
 *   5. Compara com min threshold
 *
 * Reusa `buildFlashloanCalldata` + `simulateArbitrage` do executor package.
 *
 * Modalidade flashloan = REGRA INQUEBRÁVEL do ZEUS EVM (princípio capital-light).
 * Wallet-mode pode existir no futuro, mas backrun nasce flashloan-only.
 */

import type { Address, PublicClient } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';

import {
  buildFlashloanCalldata,
  buildBackrunCalldata,
  type BribeConfig,
} from '../../executor/txBuilder';
import { selectFlashSource } from '../../executor/flashSourceSelector';
import { simulateArbitrage, type SimulationResult } from '../../executor/simulator';
import type { CrossDexOpportunity } from '../crossDex';
import type { BackrunOpportunity } from './types';

type AnyPublicClient = PublicClient<any, any>;

// Aave V3 flashloan premium (universal, immutable feature)
const AAVE_FLASHLOAN_PREMIUM_BPS = 5n;
const BPS_DENOMINATOR = 10_000n;

export interface ValidateBackrunParams {
  client: AnyPublicClient;
  /** Chain config — usado pra selecionar a fonte de flashloan mais barata (Morpho/Balancer 0%). */
  chainConfig: ChainConfig;
  opp: BackrunOpportunity;
  executorAddress: Address;
  callerAddress: Address;
  /** Slippage tolerada nos swaps (default 50bps). */
  slippageBps?: number;
  /** Margem de segurança em minProfit (default 75% do esperado). */
  minProfitMarginBps?: number;
  /** Threshold mínimo de profit em USD (default $1 — backrun é small ticket). */
  minNetProfitUsd?: number;
  /** Estimativa de gas em USD pra Base (default $0.50). */
  estimatedGasUsd?: number;
  blockNumber?: bigint;
  /** Bribe config opcional. Quando presente, encoda via `executeFlashloanBackrun` (v7).
   *  Quando ausente, encoda via `executeFlashloanArbitrage` (v6 fallback compatível). */
  bribe?: BribeConfig;
}

export interface ValidateBackrunResult {
  passed: boolean;
  reason?: string;
  /** Simulação on-chain (sucesso ou revert decoded). */
  simulation: SimulationResult | null;
  /** Profit líquido em USD após gas + flashloan fee. */
  netProfitUsd: number;
  /** Calldata pronta pra dispatch (somente se passed=true). */
  calldata?: `0x${string}`;
  /** Amount do flashloan em wei. */
  flashloanAmount?: bigint;
  /** Asset do flashloan. */
  flashloanAsset?: Address;
}

/**
 * Converte BackrunOpportunity → CrossDexOpportunity (estrutura aceita pelos
 * builders existentes). Mapeamento direto — backrun é um cross-DEX arb especial,
 * só muda o trigger.
 */
function backrunToCrossDex(opp: BackrunOpportunity): CrossDexOpportunity {
  return {
    pair: opp.pair,
    direction: 'AtoB-BtoA',
    buyQuote: opp.buyQuote,
    sellQuote: opp.sellQuote,
    amountIn: opp.amountIn,
    amountOut: opp.amountOut,
    profitWei: opp.profitWei,
    profitBps: opp.profitBps,
    profitUsd: opp.profitUsd,
    blockNumber: opp.blockNumber,
    detectedAt: opp.detectedAt,
  };
}

export async function validateBackrunProfit(
  params: ValidateBackrunParams,
): Promise<ValidateBackrunResult> {
  const {
    client,
    chainConfig,
    opp,
    executorAddress,
    callerAddress,
    slippageBps = 50,
    minProfitMarginBps = 7_500,
    minNetProfitUsd = 1,
    estimatedGasUsd = 0.5,
    blockNumber,
    bribe,
  } = params;

  const flashloanAsset = opp.whale.tokenIn;
  const flashloanAmount = opp.amountIn;

  // Seletor de fonte de flashloan: Morpho/Balancer 0% > Aave 0,05% (antes forçava Aave).
  // Fail-safe pro Aave em qualquer erro de RPC.
  const flashSel = await selectFlashSource(client, chainConfig, flashloanAsset, flashloanAmount);

  // 1. Encoda calldata. Com bribe → executeFlashloanBackrun (v7). Sem → fallback v6.
  const calldata = bribe
    ? buildBackrunCalldata({
        opp: backrunToCrossDex(opp),
        profitReceiver: callerAddress,
        slippageBps,
        minProfitMarginBps,
        flashloanAsset,
        flashloanAmount,
        bribe,
        flashSource: flashSel.flashSource,
      })
    : buildFlashloanCalldata({
        opp: backrunToCrossDex(opp),
        profitReceiver: callerAddress,
        slippageBps,
        minProfitMarginBps,
        flashloanAsset,
        flashloanAmount,
        flashSource: flashSel.flashSource,
      });

  // 2. Simula via eth_call
  const simulation = await simulateArbitrage({
    client,
    executorAddress,
    callerAddress,
    calldata,
    blockNumber,
  });

  if (!simulation.success) {
    return {
      passed: false,
      reason: `simulation revert: ${simulation.revertReason ?? 'unknown'}`,
      simulation,
      netProfitUsd: 0,
    };
  }

  // 3. Calcula custos: flashloan fee + gas
  const flashloanFeeWei = (flashloanAmount * AAVE_FLASHLOAN_PREMIUM_BPS) / BPS_DENOMINATOR;
  const cycleToken = opp.whale.tokenIn;
  const decimals = opp.whale.tokenInDecimals;
  const cycleTokenUsd =
    cycleToken.toLowerCase() === opp.pair.tokenA.toLowerCase()
      ? opp.pair.estimatedUsdValueA
      : opp.pair.estimatedUsdValueB;
  const flashloanFeeUsd =
    (Number(flashloanFeeWei) / Math.pow(10, decimals)) * cycleTokenUsd;

  const netProfitUsd = opp.profitUsd - estimatedGasUsd - flashloanFeeUsd;

  if (netProfitUsd < minNetProfitUsd) {
    return {
      passed: false,
      reason: `net profit $${netProfitUsd.toFixed(4)} < min $${minNetProfitUsd}`,
      simulation,
      netProfitUsd,
    };
  }

  return {
    passed: true,
    simulation,
    netProfitUsd,
    calldata,
    flashloanAmount,
    flashloanAsset,
  };
}
