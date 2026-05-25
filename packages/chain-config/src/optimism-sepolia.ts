/**
 * Optimism Sepolia testnet (chain id 11155420) — endereços validados.
 *
 * Fonte: github.com/bgd-labs/aave-address-book → AaveV3OptimismSepolia.sol
 */

import type { ChainConfig } from './types';

export const OPTIMISM_SEPOLIA: ChainConfig = {
  chainId: 11155420,
  name: 'OP Sepolia',
  shortName: 'optimism-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorer: 'https://sepolia-optimism.etherscan.io',
  isTestnet: true,

  tokens: {
    ETH:  '0x0000000000000000000000000000000000000000',
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
  },

  aave: {
    poolAddressesProvider: '0x36616cf17557639614c1cdDb356b1B83fc0B2132',
    pool: '0xb50201558B00496A145fE76f7424749556E326D8',
    oracle: '0x0000000000000000000000000000000000000000',
    aaveDataProvider: '0x0000000000000000000000000000000000000000',
  },

  uniswapV3: {
    swapRouter02: '0x0000000000000000000000000000000000000000',
    quoterV2: '0x0000000000000000000000000000000000000000',
    feeTiers: [500, 3000] as const,
  },

  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
