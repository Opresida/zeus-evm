/**
 * Arbitrum One mainnet (chain id 42161) — endereços de protocolos chave.
 *
 * Aave V3: ~$2B TVL, ~3.000-5.000 borrowers ativos.
 * Edge esperada: alta — menos competido que mainnet, mais TVL que Base.
 *
 * Fontes:
 *  - Aave V3: github.com/bgd-labs/aave-address-book → AaveV3Arbitrum.sol
 *  - Uniswap V3: docs.uniswap.org/contracts/v3/reference/deployments
 */

import type { ChainConfig } from './types';

export const ARBITRUM_MAINNET: ChainConfig = {
  chainId: 42161,
  name: 'Arbitrum One',
  shortName: 'arbitrum',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorer: 'https://arbiscan.io',

  tokens: {
    ETH:  '0x0000000000000000000000000000000000000000',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Native USDC (não bridged)
    'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // bridged legacy
    USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    DAI:  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  },

  // ─── Aave V3 ───
  aave: {
    poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    oracle: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7',
    aaveDataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
  },

  // ─── Uniswap V3 ───
  uniswapV3: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    universalRouter: '0x5E325eDA8064b456f4781070C0738d849c824258',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    nftPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    feeTiers: [100, 500, 3000, 10000] as const,
  },

  // Sushiswap V2 / Camelot V2 podem ser adicionados depois se quisermos cross-DEX

  // ─── Compound III (Comet) ───
  compoundV3: {
    cUSDCv3: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', // baseToken=USDC native
    cWETHv3: '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486', // baseToken=WETH
    // cUSDC.ev3 = 0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA (bridged USDC, menos relevante)
  },

  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
