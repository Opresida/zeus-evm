/**
 * Base mainnet (chain id 8453) — endereços de protocolos chave.
 *
 * Fontes oficiais:
 *  - Aave V3: https://aave.com/docs/resources/addresses
 *  - Uniswap V3: https://docs.uniswap.org/contracts/v3/reference/deployments
 *  - Aerodrome: https://aerodrome.finance/docs
 *
 * IMPORTANTE: SEMPRE conferir endereços nos docs oficiais ao deployar — endereços
 * podem mudar com upgrades de protocolo.
 */

import type { ChainConfig } from './types';

export const BASE_MAINNET: ChainConfig = {
  chainId: 8453,
  name: 'Base',
  shortName: 'base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorer: 'https://basescan.org',

  // ─── Tokens canônicos ───
  tokens: {
    ETH:  '0x0000000000000000000000000000000000000000',
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // bridged USDC (legado)
    cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    DAI:   '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    USDT:  '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    AERO:  '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // Aerodrome governance token
  },

  // ─── Aave V3 ───
  aave: {
    poolAddressesProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    oracle: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156',
    aaveDataProvider: '0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad',
  },

  // ─── Uniswap V3 ───
  uniswapV3: {
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
    universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    nftPositionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    feeTiers: [100, 500, 3000, 10000] as const, // 0.01%, 0.05%, 0.3%, 1%
  },

  // ─── Aerodrome (Velodrome fork) ───
  aerodrome: {
    router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
    ve: '0xebf418fe2512e7E6bd9b87a8F0f294aCDC67e6B4',
  },

  // ─── BaseSwap (UniswapV2 fork) ───
  baseswap: {
    router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
    factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
  },

  // ─── Compound III ───
  compoundV3: {
    cUSDCv3: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
    cWETHv3: '0x46e6b214b524310239732D51387075E0e70970bf',
  },

  // ─── Morpho ───
  morpho: {
    morphoBlue: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  },

  // ─── Multicall ───
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
