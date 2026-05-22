import type { Address } from 'viem';

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

  uniswapV3: {
    factory: Address;
    swapRouter02: Address;
    universalRouter: Address;
    quoterV2: Address;
    nftPositionManager: Address;
    feeTiers: readonly number[];
  };

  aerodrome?: {
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

  multicall3: Address;
}
