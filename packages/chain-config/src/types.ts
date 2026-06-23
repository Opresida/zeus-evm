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

  /**
   * DEXes UniswapV2-compatíveis (BaseSwap, AlienBase, SwapBased…). Todos compartilham a
   * ABI canônica do Router02 (`swapExactTokensForTokens` + `getAmountsOut`) e do Factory
   * (`getPair`/`allPairs`). Lista → adicionar venue novo é só config. On-chain executa via
   * `DexType.UniswapV2` (UniswapV2Lib). `quoter` é opcional (UniV2 cota via router.getAmountsOut).
   * ⚠️ VERIFICAR cada endereço on-chain (factory.getPair != 0) antes de habilitar em mainnet.
   */
  univ2Dexes?: Array<{
    name: string;
    router: Address;
    factory: Address;
  }>;

  /**
   * Forks ABI-compatíveis do Uniswap V3 (Pancake V3, Sushi V3…). Reusam `DexType.UniswapV3`
   * on-chain (mesma `exactInputSingle`/QuoterV2) — só endereços diferentes. `feeTiers` pode
   * divergir do UniV3 canônico (ex: Pancake V3 usa 2500 no lugar de 3000).
   * ⚠️ VERIFICAR cada endereço on-chain antes de habilitar em mainnet.
   */
  univ3Forks?: Array<{
    name: string;
    factory: Address;
    quoterV2: Address;
    swapRouter: Address;
    feeTiers: readonly number[];
  }>;

  /**
   * Aerodrome Slipstream (concentrated liquidity). NÃO é ABI-compatível com UniV3:
   * `getPool` usa `int24 tickSpacing` (não `uint24 fee`) e o SwapRouter tem `deadline` na struct.
   * On-chain executa via `DexType.Slipstream` (SlipstreamLib). Pricing reusa a math UniV3 (slot0).
   * ⚠️ VERIFICAR endereços + tickSpacings on-chain antes de habilitar em mainnet.
   */
  slipstream?: {
    factory: Address;
    quoter: Address;
    swapRouter: Address;
    tickSpacings: readonly number[];
  };

  compoundV3?: {
    cUSDCv3: Address;
    cWETHv3: Address;
  };

  morpho?: {
    morphoBlue: Address;
  };

  /** Balancer V2 Vault — fonte de flashloan 0% (endereço canônico em todas as chains EVM).
   *  Usado pelo seletor de fonte de flashloan como alternativa 0% à Aave (0,05%). */
  balancer?: {
    vault: Address;
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
