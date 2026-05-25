/**
 * Tipos compartilhados de discovery Aave V3.
 *
 * `AaveLiquidatablePosition` é o tipo "completo" emitido pelo `discoverAaveLiquidatablePositions`:
 * tem tudo que um liquidator precisa pra montar dispatch.
 */

import type { Address } from 'viem';

/** Candidato cru do subgraph (apenas user + count de reserves emprestados). */
export interface AaveCandidate {
  user: Address;
  borrowedReservesCount: number;
}

/** Position liquidável Aave V3 com par (collateral, debt) já resolvido. */
export interface AaveLiquidatablePosition {
  borrower: Address;
  collateralAsset: Address;
  debtAsset: Address;
  /** Wei do debtAsset (debt total atual). */
  totalDebtWei: bigint;
  /** Wei do collateralAsset (collateral atual). */
  totalCollateralWei: bigint;
  /** Health factor atual (1e18 = 1.0). */
  healthFactor: bigint;
  /** Bonus de liquidação aplicável ao collateralAsset (em bps, ex: 750 = 7.5%). */
  liquidationBonusBps: number;
  /** Decimais do debtAsset. */
  debtAssetDecimals: number;
  /** Decimais do collateralAsset. */
  collateralAssetDecimals: number;
  /** Symbol do debtAsset (apenas log). */
  debtAssetSymbol: string;
  /** Symbol do collateralAsset (apenas log). */
  collateralAssetSymbol: string;
}
