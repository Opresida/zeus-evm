/**
 * TxBuilder — converte CrossDexOpportunity → calldata pronto pra `eth_call` / `sendTransaction`.
 *
 * Mapeia os Quotes (que sabem qual DEX e fee) pra `SwapStep[]` que o ZeusExecutor
 * entende. Encoda via ABI do ZeusExecutor.
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';

import { ZEUS_EXECUTOR_ABI } from './abi';
import { DexType, type Quote } from '@zeus-evm/dex-adapters';
import { BASE_MAINNET } from '@zeus-evm/chain-config';
import type { CrossDexOpportunity } from '../opportunities';

/** SwapStep como o contrato espera */
export interface SolidityNumSwapStep {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  dexType: number; // uint8
  extraData: Hex;
}

/**
 * Resolve o `router` correto pra cada Quote.
 * QuoterV2 não é executor — precisamos do SwapRouter02 (UniV3) ou Aerodrome Router.
 */
function resolveRouter(dex: DexType): Address {
  switch (dex) {
    case DexType.UniswapV3:
      return BASE_MAINNET.uniswapV3.swapRouter02;
    case DexType.Aerodrome:
      if (!BASE_MAINNET.aerodrome) throw new Error('Aerodrome config missing');
      return BASE_MAINNET.aerodrome.router;
    default:
      throw new Error(`Unsupported DexType: ${dex}`);
  }
}

/**
 * Constrói os 2 SwapSteps a partir de uma CrossDexOpportunity.
 * Step 1: buy (tokenA→tokenB)
 * Step 2: sell (tokenB→tokenA com amountIn=0 = usa saldo atual)
 */
export function buildSwapSteps(opp: CrossDexOpportunity, slippageBps: number = 50): SolidityNumSwapStep[] {
  const slippageDivisor = 10_000n - BigInt(slippageBps);

  // Aplica slippage: aceita até (1 - slippageBps/10000) do amountOut esperado
  const buyMin = (opp.buyQuote.amountOut * slippageDivisor) / 10_000n;
  const sellMin = (opp.sellQuote.amountOut * slippageDivisor) / 10_000n;

  return [
    {
      router: resolveRouter(opp.buyQuote.dex),
      tokenIn: opp.buyQuote.tokenIn,
      tokenOut: opp.buyQuote.tokenOut,
      amountIn: opp.amountIn,
      minAmountOut: buyMin,
      dexType: opp.buyQuote.dex,
      extraData: opp.buyQuote.extraData,
    },
    {
      router: resolveRouter(opp.sellQuote.dex),
      tokenIn: opp.sellQuote.tokenIn,
      tokenOut: opp.sellQuote.tokenOut,
      amountIn: 0n, // usa saldo atual de tokenB do step anterior
      minAmountOut: sellMin,
      dexType: opp.sellQuote.dex,
      extraData: opp.sellQuote.extraData,
    },
  ];
}

export interface BuildArbCalldataParams {
  opp: CrossDexOpportunity;
  profitReceiver: Address;
  slippageBps?: number;
  /** Margem de segurança: minProfit aceito é (oppProfit * marginBps) / 10_000 */
  minProfitMarginBps?: number;
}

/**
 * Encoda calldata pra executeArbitrage (modalidade capital próprio).
 */
export function buildArbitrageCalldata(params: BuildArbCalldataParams): Hex {
  const { opp, profitReceiver, slippageBps = 50, minProfitMarginBps = 7_500 } = params;

  const steps = buildSwapSteps(opp, slippageBps);
  const minProfit = (opp.profitWei * BigInt(minProfitMarginBps)) / 10_000n;

  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeArbitrage',
    args: [
      {
        steps,
        minProfitWei: minProfit,
        profitToken: opp.pair.tokenA,
        profitReceiver,
      },
    ],
  });
}

export interface BuildFlashloanCalldataParams extends BuildArbCalldataParams {
  /** Asset emprestado (geralmente o profitToken pra simplicidade) */
  flashloanAsset: Address;
  /** Quantia emprestada */
  flashloanAmount: bigint;
}

/**
 * Encoda calldata pra executeFlashloanArbitrage (modalidade flashloan).
 */
export function buildFlashloanCalldata(params: BuildFlashloanCalldataParams): Hex {
  const { opp, profitReceiver, slippageBps = 50, minProfitMarginBps = 7_500, flashloanAsset, flashloanAmount } = params;

  const steps = buildSwapSteps(opp, slippageBps);
  const minProfit = (opp.profitWei * BigInt(minProfitMarginBps)) / 10_000n;

  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeFlashloanArbitrage',
    args: [
      flashloanAsset,
      flashloanAmount,
      {
        steps,
        minProfitWei: minProfit,
        profitToken: opp.pair.tokenA,
        profitReceiver,
      },
    ],
  });
}

// ════════ V7: bribe + backrun ════════

/**
 * Configuração de bribe pra calldatas v7 (executeFlashloanBackrun e variantes WithBribe).
 *
 * Bribe é pago em native token (ETH) via `block.coinbase.transfer` no contrato.
 * Quando profitToken != WETH, o contrato faz swap inline `profitToken → WETH → unwrap → transfer`.
 * Quando profitToken == WETH, só unwrap (custo extra zero).
 *
 * Validações on-chain replicadas pra fail-early off-chain (ver `validateBribeConfig`):
 *   - bribeBps em [1, 10000] OU (bribeBps=0 e minBribeWei=0 = no-op)
 *   - bribeMaxBps em [1, 9900]
 *   - swapSlippageBps <= 1000
 *   - quando bribeBps > 0 e profitToken != WETH: swapFeeTier > 0 obrigatório
 */
/**
 * Tipos alinhados com Solidity:
 *   - bribeBps, minBribeWei, bribeMaxBps, swapSlippageBps: uint256 → bigint
 *   - swapFeeTier: uint24 → number (viem mapeia uint24 pra number)
 */
export interface BribeConfig {
  /** % do profit em bps. 0n = sem bribe (config no-op se minBribeWei também 0n). */
  bribeBps: bigint;
  /** Floor absoluto em wei NATIVE token. Bribe nunca cai abaixo disso. */
  minBribeWei: bigint;
  /** Cap absoluto em bps. Bribe nunca passa disso (contrato clampa runtime). */
  bribeMaxBps: bigint;
  /** Fee tier UniV3 do pool profitToken/WETH usado no swap inline. */
  swapFeeTier: number;
  /** Slippage tolerada no swap inline (bps). */
  swapSlippageBps: bigint;
}

/** Helper pra config "sem bribe" (passa o validator + roda como flashloan-arb normal). */
export const NO_BRIBE: BribeConfig = {
  bribeBps: 0n,
  minBribeWei: 0n,
  bribeMaxBps: 0n,
  swapFeeTier: 0,
  swapSlippageBps: 0n,
};

/**
 * Valida BribeConfig off-chain (mesma lógica do _validateBribeConfig on-chain).
 * Lança Error com mensagem descritiva pra debug rápido. Custa ~0ms — sempre rodar
 * antes de buildXxxCalldata pra evitar revert tarde no router.
 */
export function validateBribeConfig(bribe: BribeConfig): void {
  // No-op é válido
  if (bribe.bribeBps === 0n && bribe.minBribeWei === 0n) return;
  if (bribe.bribeBps === 0n) {
    throw new Error('bribe inválido: minBribeWei > 0 sem bribeBps base (M-03 fix)');
  }
  if (bribe.bribeBps > 10_000n) {
    throw new Error(`bribe inválido: bribeBps=${bribe.bribeBps} > 10000`);
  }
  if (bribe.bribeMaxBps === 0n || bribe.bribeMaxBps > 9_900n) {
    throw new Error(`bribe inválido: bribeMaxBps=${bribe.bribeMaxBps} fora de [1, 9900]`);
  }
  if (bribe.swapSlippageBps > 1_000n) {
    throw new Error(`bribe inválido: swapSlippageBps=${bribe.swapSlippageBps} > 1000`);
  }
}

export interface BuildBackrunCalldataParams {
  opp: CrossDexOpportunity;
  profitReceiver: Address;
  slippageBps?: number;
  minProfitMarginBps?: number;
  flashloanAsset: Address;
  flashloanAmount: bigint;
  bribe: BribeConfig;
  /** Profit token alvo. Default = opp.pair.tokenA (tipicamente == flashloanAsset). */
  profitToken?: Address;
}

/**
 * Encoda calldata pra `executeFlashloanBackrun` (v7).
 *
 * Diferença vs `buildFlashloanCalldata`:
 *   - Aceita BribeConfig (pode ser NO_BRIBE)
 *   - Discriminator dedicado on-chain (OperationType.FlashloanBackrun)
 *   - Observabilidade melhor (event BackrunExecuted + BribePaid)
 */
export function buildBackrunCalldata(params: BuildBackrunCalldataParams): Hex {
  const {
    opp,
    profitReceiver,
    slippageBps = 50,
    minProfitMarginBps = 7_500,
    flashloanAsset,
    flashloanAmount,
    bribe,
    profitToken,
  } = params;

  validateBribeConfig(bribe);

  const steps = buildSwapSteps(opp, slippageBps);
  const minProfit = (opp.profitWei * BigInt(minProfitMarginBps)) / 10_000n;

  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeFlashloanBackrun',
    args: [
      flashloanAsset,
      flashloanAmount,
      {
        steps,
        minProfitWei: minProfit,
        profitToken: profitToken ?? opp.pair.tokenA,
        profitReceiver,
        bribe,
      },
    ],
  });
}

/**
 * Encoda calldata pra `executeLiquidationWithBribe` (v7).
 *
 * Caller passa LiquidationParams (mesma estrutura do v6) + BribeConfig separado.
 * Quando NO_BRIBE, vira equivalente ao v6 executeLiquidation mas com path observável.
 */
export interface BuildLiquidationWithBribeParams {
  user: Address;
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
  swapSteps: SolidityNumSwapStep[];
  minProfitWei: bigint;
  profitReceiver: Address;
  bribe: BribeConfig;
}

export function buildLiquidationWithBribeCalldata(
  params: BuildLiquidationWithBribeParams,
): Hex {
  validateBribeConfig(params.bribe);
  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeLiquidationWithBribe',
    args: [
      {
        user: params.user,
        collateralAsset: params.collateralAsset,
        debtAsset: params.debtAsset,
        debtToCover: params.debtToCover,
        swapSteps: params.swapSteps,
        minProfitWei: params.minProfitWei,
        profitReceiver: params.profitReceiver,
      },
      params.bribe,
    ],
  });
}

export interface BuildCompoundLiquidationWithBribeParams {
  comet: Address;
  borrower: Address;
  collateralAsset: Address;
  baseAmount: bigint;
  minCollateralReceived: bigint;
  swapSteps: SolidityNumSwapStep[];
  minProfitWei: bigint;
  profitReceiver: Address;
  bribe: BribeConfig;
}

export function buildCompoundLiquidationWithBribeCalldata(
  params: BuildCompoundLiquidationWithBribeParams,
): Hex {
  validateBribeConfig(params.bribe);
  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeCompoundLiquidationWithBribe',
    args: [
      {
        comet: params.comet,
        borrower: params.borrower,
        collateralAsset: params.collateralAsset,
        baseAmount: params.baseAmount,
        minCollateralReceived: params.minCollateralReceived,
        swapSteps: params.swapSteps,
        minProfitWei: params.minProfitWei,
        profitReceiver: params.profitReceiver,
      },
      params.bribe,
    ],
  });
}

export interface BuildMorphoLiquidationWithBribeParams {
  morpho: Address;
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
  borrower: Address;
  seizedAssets: bigint;
  repaidShares: bigint;
  flashloanAmount: bigint;
  swapSteps: SolidityNumSwapStep[];
  minProfitWei: bigint;
  profitReceiver: Address;
  bribe: BribeConfig;
}

export function buildMorphoLiquidationWithBribeCalldata(
  params: BuildMorphoLiquidationWithBribeParams,
): Hex {
  validateBribeConfig(params.bribe);
  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeMorphoLiquidationWithBribe',
    args: [
      {
        morpho: params.morpho,
        loanToken: params.loanToken,
        collateralToken: params.collateralToken,
        oracle: params.oracle,
        irm: params.irm,
        lltv: params.lltv,
        borrower: params.borrower,
        seizedAssets: params.seizedAssets,
        repaidShares: params.repaidShares,
        flashloanAmount: params.flashloanAmount,
        swapSteps: params.swapSteps,
        minProfitWei: params.minProfitWei,
        profitReceiver: params.profitReceiver,
      },
      params.bribe,
    ],
  });
}
