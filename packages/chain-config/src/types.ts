import type { Address } from 'viem';

/**
 * Config de um mercado Aave-compatível (Aave V3 core OU fork como Seamless).
 * `label` é o identificador usado pelo scorer/reporters (ex: 'aave-v3', 'seamless').
 */
export interface AaveMarketConfig {
  label: string;
  poolAddressesProvider: Address;
  pool: Address;
  oracle: Address;
  aaveDataProvider: Address;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  shortName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorer: string;

  tokens: Record<string, Address>;

  aave: {
    poolAddressesProvider: Address;
    pool: Address;
    oracle: Address;
    aaveDataProvider: Address;
  };

  /**
   * Forks do Aave V3 (mesma ABI: Pool/Oracle/DataProvider) na mesma chain.
   * Ex: Seamless, ZeroLend. Reusam 100% o pipeline Aave — só endereços diferentes.
   * Cada fork é tratado como um "protocol" distinto pro scorer/reporters.
   */
  aaveForks?: AaveMarketConfig[];

  uniswapV3: {
    factory?: Address;
    swapRouter02: Address;
    universalRouter?: Address;
    quoterV2: Address;
    nftPositionManager?: Address;
    feeTiers: readonly number[];
  };

  /** Testnet flag — só true em chains sem liquidez/oportunidade real */
  isTestnet?: boolean;

  aerodrome?: {
    router: Address;
    factory: Address;
    voter: Address;
    ve: Address;
  };

  /** Velodrome V2 — fork direto do Aerodrome (mesmo ABI Router/Factory).
   *  Optimism principal: 'velodrome'. Base principal: 'aerodrome'.
   *  Ambos compartilham `quoteAerodrome` adapter (apenas endereços diferentes). */
  velodrome?: {
    router: Address;
    factory: Address;
    voter: Address;
    ve: Address;
  };

  baseswap?: {
    router: Address;
    factory: Address;
  };

  compoundV3?: {
    cUSDCv3: Address;
    cWETHv3: Address;
  };

  morpho?: {
    morphoBlue: Address;
  };

  /** Moonwell (Compound V2 fork) — Comptroller. mTokens via getAllMarkets() on-chain. */
  moonwell?: {
    comptroller: Address;
  };

  /** Trader Joe v2.2 "Liquidity Book" (Avalanche). DEX nativo pro Motor 2 cross-DEX. */
  traderJoe?: {
    lbFactory: Address;
    lbRouter: Address;
  };

  multicall3: Address;
}
