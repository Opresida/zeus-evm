/**
 * Morpho Blue — matemática de shares, health factor e liquidation incentive.
 *
 * Replica FIELMENTE o on-chain (SharesMathLib + MathLib + Morpho._isHealthy +
 * Morpho.liquidate) pra que o cálculo off-chain bata com o que o contrato faz.
 *
 * Fontes: github.com/morpho-org/morpho-blue
 *   - libraries/SharesMathLib.sol (virtual shares)
 *   - libraries/MathLib.sol (wMul/wDiv/mulDiv)
 *   - Morpho.sol _isHealthy + liquidate
 *
 * ⚠️ Math sensível — qualquer divergência aqui causa revert on-chain. Testado em
 * morphoMath.test.ts contra valores conhecidos.
 */

// ─── Constantes on-chain ───
export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const LIQUIDATION_CURSOR = 3n * 10n ** 17n;            // 0.3e18
export const MAX_LIQUIDATION_INCENTIVE_FACTOR = 115n * 10n ** 16n; // 1.15e18
// SharesMathLib virtual shares (anti-inflation)
export const VIRTUAL_SHARES = 10n ** 6n;
export const VIRTUAL_ASSETS = 1n;

// ─── mulDiv ───
export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d;
}
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + (d - 1n)) / d;
}

// ─── WAD math ───
export function wMulDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, y, WAD);
}
export function wDivDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, WAD, y);
}
export function wDivUp(x: bigint, y: bigint): bigint {
  return mulDivUp(x, WAD, y);
}

// ─── SharesMathLib (virtual shares) ───
export function toAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}
export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}
export function toSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}
export function toSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}

export interface MorphoMarketTotals {
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
}

export interface MorphoPositionState {
  borrowShares: bigint;
  collateral: bigint;
}

/**
 * Dívida do borrower em ASSETS do loanToken (toAssetsUp do borrowShares).
 */
export function borrowedAssets(position: MorphoPositionState, market: MorphoMarketTotals): bigint {
  return toAssetsUp(position.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
}

/**
 * Max borrow permitido = collateral × price / 1e36 × lltv.
 * Replica Morpho._isHealthy: isHealthy = maxBorrow >= borrowed.
 */
export function maxBorrowAssets(collateral: bigint, collateralPrice: bigint, lltv: bigint): bigint {
  const collateralValue = mulDivDown(collateral, collateralPrice, ORACLE_PRICE_SCALE);
  return wMulDown(collateralValue, lltv);
}

/**
 * Health factor = maxBorrow / borrowed (1e18 scale). HF < 1e18 = liquidável.
 * Retorna MAX se borrowed == 0 (sem dívida = saudável).
 */
export function healthFactor(
  position: MorphoPositionState,
  market: MorphoMarketTotals,
  collateralPrice: bigint,
  lltv: bigint,
): bigint {
  const borrowed = borrowedAssets(position, market);
  if (borrowed === 0n) return 2n ** 256n - 1n;
  const maxBorrow = maxBorrowAssets(position.collateral, collateralPrice, lltv);
  return wDivDown(maxBorrow, borrowed);
}

export function isLiquidatable(
  position: MorphoPositionState,
  market: MorphoMarketTotals,
  collateralPrice: bigint,
  lltv: bigint,
): boolean {
  const borrowed = borrowedAssets(position, market);
  if (borrowed === 0n) return false;
  const maxBorrow = maxBorrowAssets(position.collateral, collateralPrice, lltv);
  return borrowed > maxBorrow;
}

/**
 * Liquidation Incentive Factor (LIF).
 * LIF = min(MAX_LIF, 1 / (1 - cursor × (1 - lltv)))
 */
export function liquidationIncentiveFactor(lltv: bigint): bigint {
  const denom = WAD - wMulDown(LIQUIDATION_CURSOR, WAD - lltv);
  const lif = wDivDown(WAD, denom);
  return lif < MAX_LIQUIDATION_INCENTIVE_FACTOR ? lif : MAX_LIQUIDATION_INCENTIVE_FACTOR;
}

export interface LiquidationPlan {
  /** Modo: 'repayAll' (passa repaidShares) ou 'seizeAll' (passa seizedAssets). */
  mode: 'repayAll' | 'seizeAll';
  /** repaidShares pra passar no param (0 se mode=seizeAll). */
  repaidShares: bigint;
  /** seizedAssets pra passar no param (0 se mode=repayAll). */
  seizedAssets: bigint;
  /** Colateral que será efetivamente seizado (pra estimar swap). */
  expectedSeizedCollateral: bigint;
  /** Assets do loanToken que serão repagos (= flashloan necessário). */
  expectedRepaidAssets: bigint;
}

/**
 * Decide o plano de liquidação ótimo replicando a lógica do Morpho.liquidate.
 *
 * Estratégia: tentar repagar TODA a dívida (repaidShares = borrowShares). Se o
 * colateral seizado pra isso couber no colateral disponível, usa repayAll.
 * Senão, seiza TODO o colateral (seizeAll) e o contrato deriva o repaidShares.
 *
 * Retorna null se a math degenerar (sem colateral/dívida).
 */
export function planLiquidation(
  position: MorphoPositionState,
  market: MorphoMarketTotals,
  collateralPrice: bigint,
  lltv: bigint,
): LiquidationPlan | null {
  if (position.borrowShares === 0n || position.collateral === 0n) return null;
  if (collateralPrice === 0n) return null;

  const lif = liquidationIncentiveFactor(lltv);

  // Caminho A — repagar tudo: repaidShares = borrowShares
  const repaidAssetsFull = toAssetsUp(position.borrowShares, market.totalBorrowAssets, market.totalBorrowShares);
  // seizedAssets derivado (Morpho.liquidate, ramo repaidShares):
  //   seized = mulDivDown(wMulDown(repaidAssets, LIF), ORACLE_PRICE_SCALE, price)
  const seizedForFull = mulDivDown(wMulDown(repaidAssetsFull, lif), ORACLE_PRICE_SCALE, collateralPrice);

  if (seizedForFull <= position.collateral) {
    return {
      mode: 'repayAll',
      repaidShares: position.borrowShares,
      seizedAssets: 0n,
      expectedSeizedCollateral: seizedForFull,
      expectedRepaidAssets: repaidAssetsFull,
    };
  }

  // Caminho B — seizar todo o colateral: seizedAssets = collateral
  //   seizedAssetsQuoted = mulDivUp(seized, price, ORACLE_PRICE_SCALE)
  //   repaidShares = toSharesUp(wDivUp(seizedQuoted, LIF), totals)
  const seizedQuoted = mulDivUp(position.collateral, collateralPrice, ORACLE_PRICE_SCALE);
  const repaidShares = toSharesUp(
    wDivUp(seizedQuoted, lif),
    market.totalBorrowAssets,
    market.totalBorrowShares,
  );
  const repaidAssets = toAssetsUp(repaidShares, market.totalBorrowAssets, market.totalBorrowShares);

  return {
    mode: 'seizeAll',
    repaidShares: 0n,
    seizedAssets: position.collateral,
    expectedSeizedCollateral: position.collateral,
    expectedRepaidAssets: repaidAssets,
  };
}
