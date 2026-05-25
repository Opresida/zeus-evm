/**
 * Arbitrum Sepolia testnet (chain id 421614) — endereços validados.
 *
 * Usado pra deploy + observação testnet ANTES de mainnet (Fase 5b).
 *
 * Fonte: github.com/bgd-labs/aave-address-book → AaveV3ArbitrumSepolia.sol
 */

import type { ChainConfig } from './types';

export const ARBITRUM_SEPOLIA: ChainConfig = {
  chainId: 421614,
  name: 'Arbitrum Sepolia',
  shortName: 'arbitrum-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorer: 'https://sepolia.arbiscan.io',
  isTestnet: true,

  tokens: {
    ETH:  '0x0000000000000000000000000000000000000000',
    WETH: '0x1dF462e2712496373A347f8ad10802a5E95f053D',
    USDC: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  },

  aave: {
    poolAddressesProvider: '0xB25a5D144626a0D488e52AE717A051a2E9997076',
    pool: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
    oracle: '0x0000000000000000000000000000000000000000', // não usado no contrato; nem todos os testnets têm
    aaveDataProvider: '0x0000000000000000000000000000000000000000',
  },

  // Uniswap V3 não está em Arbitrum Sepolia oficial — usar SwapRouter02 da Arbitrum se necessário.
  // Pra liquidations testnet não precisamos de DEX swap real (testes em mainnet via fork)
  uniswapV3: {
    swapRouter02: '0x0000000000000000000000000000000000000000',
    quoterV2: '0x0000000000000000000000000000000000000000',
    feeTiers: [500, 3000] as const,
  },

  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
