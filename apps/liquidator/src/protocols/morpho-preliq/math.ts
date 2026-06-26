/**
 * Morpho PRE-liquidation — matemática (banda preLltv<LTV<LLTV + preLIF/preLCF interpolados).
 *
 * Replica FIELMENTE `morpho-org/pre-liquidation` `PreLiquidation.preLiquidate` pra que o cálculo
 * off-chain bata com o contrato (senão revert: NotPreLiquidatablePosition / LiquidatablePosition /
 * PreLiquidationTooLarge). Reusa os helpers de shares/WAD do Morpho clássico (`../morpho/math`).
 *
 * ⚠️ Math sensível — qualquer divergência causa revert on-chain. Testado em math.test.ts.
 */

import {
  ORACLE_PRICE_SCALE,
  WAD,
  mulDivDown,
  mulDivUp,
  wMulDown,
  wDivUp,
  wDivDown,
  toAssetsUp,
  toAssetsDown,
  type MorphoMarketTotals,
  type MorphoPositionState,
} from '../morpho/math';

/** Config imutável de um contrato PreLiquidation (lida via `preLiquidationParams()`) + LLTV do market. */
export interface PreLiquidationConfig {
  preLltv: bigint;
  preLCF1: bigint;
  preLCF2: bigint;
  preLIF1: bigint;
  preLIF2: bigint;
  /** LLTV do market Morpho (do `marketParams()`). */
  lltv: bigint;
}

export type PreBand = 'below' | 'pre' | 'liquidatable';

/**
 * Em qual faixa a posição está, dado o preço do `preLiquidationOracle`:
 *   - 'below'        → LTV ≤ preLltv (saudável; não pré-liquidável)
 *   - 'pre'          → preLltv < LTV ≤ LLTV (PRÉ-LIQUIDÁVEL — nosso alvo)
 *   - 'liquidatable' → LTV > LLTV (liquidação clássica; preLiquidate reverte LiquidatablePosition)
 */
export function preLiquidationBand(
  position: MorphoPositionState,
  market: MorphoMarketTotals,
  collateralPrice: bigint,
  cfg: PreLiquidationConfig,
): PreBand | null {
  if (collateralPrice === 0n || position.borrowShares === 0n || position.collateral === 0n) return null;
  const collateralQuoted = mulDivDown(position.collateral, collateralPrice, ORACLE_PRICE_SCALE);
  if (collateralQuoted === 0n) return null;
  const borrowed = toAssetsUp(position.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
  if (borrowed > wMulDown(collateralQuoted, cfg.lltv)) return 'liquidatable';
  if (borrowed <= wMulDown(collateralQuoted, cfg.preLltv)) return 'below';
  return 'pre';
}

export interface PrePlan {
  /** LTV atual (WAD) computado com o preLiquidationOracle. */
  ltv: bigint;
  /** Incentive factor interpolado (WAD, ex: 1.0438e18 = 4,38% de bônus). */
  preLIF: bigint;
  /** Close factor interpolado (WAD; pode passar de WAD = fecha tudo). */
  preLCF: bigint;
  /** repaidShares a passar no param (modo por-shares; maximiza dentro do preLCF). */
  repaidShares: bigint;
  /** seizedAssets resultante (colateral que será entregue pra swap). */
  expectedSeizedCollateral: bigint;
  /** loanToken (stable) que o contrato vai puxar de nós no repay. */
  expectedRepaidAssets: bigint;
}

/**
 * Planeja a pré-liquidação MAXIMIZANDO a fatia dentro do close factor (preLCF).
 * Retorna null se a posição não está na faixa 'pre' (ou math degenera).
 *
 * Espelha `PreLiquidation.preLiquidate` (modo por-shares):
 *   ltv      = wDivUp(borrowed, collateralQuoted)
 *   quotient = wDivDown(ltv - preLltv, lltv - preLltv)
 *   preLIF   = wMulDown(quotient, preLIF2 - preLIF1) + preLIF1
 *   preLCF   = wMulDown(quotient, preLCF2 - preLCF1) + preLCF1
 *   repayable = wMulDown(borrowShares, preLCF)            ← teto da fatia
 *   seized   = wMulDown(toAssetsDown(repaidShares), preLIF) × ORACLE_PRICE_SCALE / price
 */
export function planPreLiquidation(
  position: MorphoPositionState,
  market: MorphoMarketTotals,
  collateralPrice: bigint,
  cfg: PreLiquidationConfig,
): PrePlan | null {
  const band = preLiquidationBand(position, market, collateralPrice, cfg);
  if (band !== 'pre') return null;

  const collateralQuoted = mulDivDown(position.collateral, collateralPrice, ORACLE_PRICE_SCALE);
  const borrowed = toAssetsUp(position.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);

  const ltv = wDivUp(borrowed, collateralQuoted);
  const quotient = wDivDown(ltv - cfg.preLltv, cfg.lltv - cfg.preLltv);
  const preLIF = wMulDown(quotient, cfg.preLIF2 - cfg.preLIF1) + cfg.preLIF1;
  const preLCF = wMulDown(quotient, cfg.preLCF2 - cfg.preLCF1) + cfg.preLCF1;

  // Maximiza: repaidShares = min(repayableShares, borrowShares).
  let repaidShares = wMulDown(position.borrowShares, preLCF);
  if (repaidShares > position.borrowShares) repaidShares = position.borrowShares;
  if (repaidShares === 0n) return null;

  const repaidAssetsDown = toAssetsDown(repaidShares, market.totalBorrowAssets, market.totalBorrowShares);
  const seized = mulDivDown(wMulDown(repaidAssetsDown, preLIF), ORACLE_PRICE_SCALE, collateralPrice);
  if (seized === 0n || seized > position.collateral) return null;

  const expectedRepaidAssets = toAssetsUp(repaidShares, market.totalBorrowAssets, market.totalBorrowShares);

  return { ltv, preLIF, preLCF, repaidShares, expectedSeizedCollateral: seized, expectedRepaidAssets };
}

/** Bônus bruto (em loanToken assets) embutido na pré-liq: (seized×price/scale) − repaidAssets. Pré-swap. */
export function grossBonusAssets(plan: PrePlan, collateralPrice: bigint): bigint {
  const seizedQuoted = mulDivUp(plan.expectedSeizedCollateral, collateralPrice, ORACLE_PRICE_SCALE);
  return seizedQuoted > plan.expectedRepaidAssets ? seizedQuoted - plan.expectedRepaidAssets : 0n;
}

export { WAD, ORACLE_PRICE_SCALE };
