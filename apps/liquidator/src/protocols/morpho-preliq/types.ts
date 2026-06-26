import type { Address } from 'viem';
import type { PreLiquidationConfig } from './math';

/** Info de um contrato PreLiquidation por-mercado (lido da Factory + views). */
export interface PreLiquidationContractInfo {
  /** Endereço do contrato PreLiquidation (alvo do `preLiquidate` + nosso whitelist). */
  preLiquidation: Address;
  /** Market Morpho coberto. */
  marketId: `0x${string}`;
  loanToken: Address;
  collateralToken: Address;
  /** Oracle do MARKET (marketParams.oracle). */
  marketOracle: Address;
  irm: Address;
  /** Config de pré-liquidação (preLltv/preLCF/preLIF) + LLTV do market — pra a math. */
  config: PreLiquidationConfig;
  /** Oracle usado pela pré-liquidação (PODE diferir do market oracle). */
  preLiquidationOracle: Address;
}

/** Uma posição PRÉ-liquidável encontrada pela discovery (na faixa preLltv<LTV<LLTV + autorizada). */
export interface PrePosition {
  preLiquidation: Address;
  marketId: `0x${string}`;
  borrower: Address;
  loanToken: Address;
  collateralToken: Address;
  /** Oracle da pré-liquidação (preço usado na math). */
  preLiquidationOracle: Address;
  borrowShares: bigint;
  collateral: bigint;
  /** Preço do preLiquidationOracle (scaled 1e36). */
  collateralPrice: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  /** LTV atual (WAD). */
  ltv: bigint;
  config: PreLiquidationConfig;
}
