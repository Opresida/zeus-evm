/**
 * Optimism mainnet (chain id 10) — endereços de protocolos chave.
 *
 * Aave V3: ~$1B TVL, ~1.500-3.000 borrowers ativos.
 * Edge esperada: alta — semelhante a Arbitrum em termos de competição.
 *
 * Fontes:
 *  - Aave V3: github.com/bgd-labs/aave-address-book → AaveV3Optimism.sol
 *  - Uniswap V3: docs.uniswap.org/contracts/v3/reference/deployments
 */

import type { ChainConfig } from './types';

export const OPTIMISM_MAINNET: ChainConfig = {
  chainId: 10,
  name: 'OP Mainnet',
  shortName: 'optimism',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorer: 'https://optimistic.etherscan.io',

  tokens: {
    ETH:  '0x0000000000000000000000000000000000000000',
    WETH: '0x4200000000000000000000000000000000000006', // pré-deploy padrão OP Stack
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Native USDC
    'USDC.e': '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // bridged legacy
    USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    DAI:  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    WBTC: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
    OP:   '0x4200000000000000000000000000000000000042', // Optimism governance token
    VELO: '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db', // Velodrome V2 governance
  },

  // ─── Aave V3 (mesmo POOL address que Arbitrum — CREATE2 deterministic!) ───
  aave: {
    poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    oracle: '0xD81eb3728a631871a7eBBaD631b5f424909f0c77',
    aaveDataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
  },

  // ─── Uniswap V3 ───
  uniswapV3: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    universalRouter: '0xCb1355ff08Ab38bBCE60111F1bb2B784bE25D7e8',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    nftPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    feeTiers: [100, 500, 3000, 10000] as const,
  },

  // ─── Compound III (Comet) ───
  compoundV3: {
    cUSDCv3: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB', // baseToken=USDC native Optimism
    // cWETHv3 + cUSDTv3 podem existir mas não confirmados — adicionar quando necessário
    cWETHv3: '0x0000000000000000000000000000000000000000', // TBD
  },

  // ─── Velodrome V2 (fork direto Aerodrome — mesmo ABI Router/Factory) ───
  // Source: github.com/velodrome-finance/contracts (V2 fork de 2024)
  velodrome: {
    router: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
    factory: '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a',
    voter: '0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C',
    ve: '0xFAf8FD17D9840595845582fCB047DF13f006787d',
  },

  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
