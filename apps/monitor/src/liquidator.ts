/**
 * Liquidator — constrói os params + simula + dispara executeLiquidation no ZeusExecutor.
 *
 * Fluxo:
 *   1. Recebe user (HF < 1.0) + dados Aave (qual collateral, qual debt)
 *   2. Calcula `debtToCover` (até 50% da dívida — Aave permite "close factor 50%")
 *   3. Estima profit: collateralReceived × bonus - debtCovered - flashloanFee
 *   4. Se profit > minProfitUsd, constrói SwapStep[] pra converter collateral → debt asset
 *   5. Simula via eth_call (sem submeter)
 *   6. Se simulação OK, submete tx real (Fase 5b+; em DRY_RUN só loga)
 */

import {
  type Address,
  type PublicClient,
  type Hex,
  encodeFunctionData,
  parseAbi,
  parseUnits,
} from 'viem';

import { ZEUS_EXECUTOR_ABI, type SolidityNumSwapStep } from '@zeus-evm/strategy';
import { DexType } from '@zeus-evm/dex-adapters';
import { BASE_MAINNET } from '@zeus-evm/chain-config';

import type { UserAccountData } from './healthFactor';

type AnyClient = PublicClient<any, any>;

// ─── Aave V3 — close factor 50% pra positions normais; 100% se HF muito baixa ───
// Ref: https://docs.aave.com/developers/whats-new/liquidation
const CLOSE_FACTOR_NORMAL_BPS = 5_000n; // 50%
const CLOSE_FACTOR_HIGH_BPS = 10_000n; // 100%
const HF_CLOSE_FACTOR_HIGH_THRESHOLD = 950_000_000_000_000_000n; // 0.95 (1e18 base)

/** Bonus de liquidação aproximado por reserve. Default 5% — pode ser refinado lendo o contrato. */
const DEFAULT_LIQUIDATION_BONUS_BPS = 500n; // 5%

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const POOL_ABI = parseAbi([
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
]);

export interface UserReserveData {
  asset: Address;
  symbol: string;
  decimals: number;
  collateralBalance: bigint;
  debtBalance: bigint; // stable + variable combined
}

export interface LiquidationPlan {
  user: Address;
  collateralAsset: Address;
  debtAsset: Address;
  debtToCover: bigint;
  estimatedCollateralReceived: bigint;
  estimatedProfitUsd: number;
  swapSteps: SolidityNumSwapStep[];
  minProfitWei: bigint;
}

/**
 * Calcula debtToCover baseado no close factor.
 * Aave V3: 50% se HF >= 0.95, 100% se HF < 0.95.
 */
export function calculateDebtToCover(userDebtBalance: bigint, healthFactor: bigint): bigint {
  const closeFactor = healthFactor < HF_CLOSE_FACTOR_HIGH_THRESHOLD ? CLOSE_FACTOR_HIGH_BPS : CLOSE_FACTOR_NORMAL_BPS;
  return (userDebtBalance * closeFactor) / 10_000n;
}

/**
 * Estima quanto colateral receberemos com o bonus.
 * collateralReceived ≈ (debtCovered_usd × (1 + bonus)) / collateralPriceUsd
 *
 * Aqui usamos uma aproximação simples — pra precisão real, precisaríamos ler
 * `liquidationBonus` de cada reserve via DataProvider do Aave.
 */
export function estimateCollateralReceived(
  debtToCoverUsd: number,
  collateralPriceUsd: number,
  collateralDecimals: number,
  bonusBps: bigint = DEFAULT_LIQUIDATION_BONUS_BPS,
): bigint {
  const grossUsd = debtToCoverUsd * (1 + Number(bonusBps) / 10_000);
  const tokens = grossUsd / collateralPriceUsd;
  return parseUnits(tokens.toFixed(Math.min(collateralDecimals, 18)), collateralDecimals);
}

/**
 * Constrói SwapSteps pra converter collateralAsset → debtAsset.
 *
 * Versão simples: rota direta via Uniswap V3 fee500 ou Aerodrome volatile.
 * Em produção isso deveria ser routing inteligente (Best Quote across DEXs).
 * Pra MVP, hardcode UniV3 fee500 (~mais alta liquidez na maioria dos pares Base).
 */
export function buildLiquidationSwapSteps(
  collateralAsset: Address,
  debtAsset: Address,
  estimatedCollateralAmount: bigint,
  slippageBps: number = 100, // 1% slippage default (liquidações tem margem maior)
): SolidityNumSwapStep[] {
  // Step único: collateralAsset → debtAsset via UniV3 fee500
  return [
    {
      router: BASE_MAINNET.uniswapV3.swapRouter02,
      tokenIn: collateralAsset,
      tokenOut: debtAsset,
      amountIn: 0n, // 0 = usa saldo atual (colateral recebido da liquidação)
      minAmountOut: 0n, // confiar no minProfitWei do contrato pra proteção
      dexType: DexType.UniswapV3,
      extraData: ('0x' + (500).toString(16).padStart(64, '0')) as Hex, // uint24 fee=500 encoded em 32 bytes
    },
  ];
}

/**
 * Constrói o plano de liquidação completo pra um user em risco.
 * @returns null se não vale a pena (profit estimado < min)
 */
export function buildLiquidationPlan(opts: {
  user: UserAccountData;
  collateralAsset: Address;
  collateralPriceUsd: number;
  collateralDecimals: number;
  debtAsset: Address;
  debtAssetDecimals: number;
  userDebtBalance: bigint; // raw token amount
  ethPriceUsd: number;
  minProfitUsd: number;
  aaveFlashloanFeeBps?: bigint;
}): LiquidationPlan | null {
  const {
    user,
    collateralAsset,
    collateralPriceUsd,
    collateralDecimals,
    debtAsset,
    debtAssetDecimals,
    userDebtBalance,
    minProfitUsd,
    aaveFlashloanFeeBps = 5n, // 0.05%
  } = opts;

  // 1. Calcula debtToCover baseado no close factor
  const debtToCover = calculateDebtToCover(userDebtBalance, user.healthFactor);

  // 2. Estima collateral recebido (com bonus)
  const debtToCoverUsd = (Number(debtToCover) / Math.pow(10, debtAssetDecimals)); // assume debtAsset stablecoin USD
  const collateralReceived = estimateCollateralReceived(
    debtToCoverUsd,
    collateralPriceUsd,
    collateralDecimals,
  );

  // 3. Estima profit em USD = (collateralReceived em USD) - debtToCoverUsd - flashloan fee
  const collateralReceivedUsd = (Number(collateralReceived) / Math.pow(10, collateralDecimals)) * collateralPriceUsd;
  const flashloanFeeUsd = debtToCoverUsd * (Number(aaveFlashloanFeeBps) / 10_000);
  // Estimativa SIMPLES: ignora slippage do swap collateral→debt (que pode comer parte do profit)
  // Em produção: simular eth_call primeiro pra ter número exato.
  const estimatedProfitUsd = collateralReceivedUsd - debtToCoverUsd - flashloanFeeUsd;

  if (estimatedProfitUsd < minProfitUsd) {
    return null; // não compensa
  }

  // 4. Constrói swapSteps pra converter colateral → debt asset
  const swapSteps = buildLiquidationSwapSteps(collateralAsset, debtAsset, collateralReceived);

  // 5. minProfitWei em debtAsset (50% do estimado pra ter margem de segurança)
  const minProfitUsdSafe = Math.max(estimatedProfitUsd * 0.5, 1);
  const minProfitWei = parseUnits(minProfitUsdSafe.toFixed(Math.min(debtAssetDecimals, 18)), debtAssetDecimals);

  return {
    user: user.user,
    collateralAsset,
    debtAsset,
    debtToCover,
    estimatedCollateralReceived: collateralReceived,
    estimatedProfitUsd,
    swapSteps,
    minProfitWei,
  };
}

/**
 * Encoda calldata do executeLiquidation pra simulação ou submissão.
 */
export function buildLiquidationCalldata(plan: LiquidationPlan, profitReceiver: Address): Hex {
  return encodeFunctionData({
    abi: ZEUS_EXECUTOR_ABI,
    functionName: 'executeLiquidation',
    args: [
      {
        user: plan.user,
        collateralAsset: plan.collateralAsset,
        debtAsset: plan.debtAsset,
        debtToCover: plan.debtToCover,
        swapSteps: plan.swapSteps,
        minProfitWei: plan.minProfitWei,
        profitReceiver,
      },
    ],
  });
}

/**
 * Lê user reserve data via getUserReserveData do Aave.
 * Usado pra descobrir collateral + debt amounts ON-CHAIN (mais preciso que subgraph).
 */
export async function getUserReserveData(
  client: AnyClient,
  poolAddress: Address,
  asset: Address,
  user: Address,
): Promise<{
  collateralBalance: bigint;
  debtBalance: bigint;
}> {
  const result = await client.readContract({
    address: poolAddress,
    abi: POOL_ABI,
    functionName: 'getUserReserveData',
    args: [asset, user],
  });

  const [aTokenBalance, stableDebt, variableDebt] = result as readonly [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean
  ];

  return {
    collateralBalance: aTokenBalance,
    debtBalance: stableDebt + variableDebt,
  };
}
