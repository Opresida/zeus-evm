/**
 * Base Sepolia testnet (chain id 84532) — endereços validados via eth_getCode.
 *
 * IMPORTANTE: Sepolia NÃO tem Aerodrome. Cross-DEX arb não é testável.
 * Use Sepolia pra validar fluxo de execução, kill switch, callback Aave,
 * e deploy do contrato. NÃO esperar profit real em testnet.
 *
 * Fontes:
 *  - Aave V3 Base Sepolia: github.com/bgd-labs/aave-address-book → AaveV3BaseSepolia.sol
 *  - Uniswap V3: docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
 */

import type { ChainConfig } from './types';

export const BASE_SEPOLIA: ChainConfig = {
  chainId: 84532,
  name: 'Base Sepolia',
  shortName: 'base-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorer: 'https://sepolia.basescan.org',
  isTestnet: true,

  // ─── Tokens (testnet) ───
  tokens: {
    ETH:  '0x0000000000000000000000000000000000000000',
    WETH: '0x4200000000000000000000000000000000000006',
    // USDC do Aave testnet (mintable via faucet do Aave)
    USDC: '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f',
  },

  // ─── Aave V3 testnet ───
  aave: {
    poolAddressesProvider: '0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00',
    pool: '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27',
    // Oracle e DataProvider só são necessários pra liquidations (Fase 6) — addresses zero por enquanto
    oracle: '0x0000000000000000000000000000000000000000',
    aaveDataProvider: '0x0000000000000000000000000000000000000000',
  },

  // ─── Uniswap V3 testnet ───
  uniswapV3: {
    swapRouter02: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
    quoterV2: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
    feeTiers: [100, 500, 3000, 10000] as const,
  },

  // ❌ Aerodrome NÃO existe em Sepolia
  // ❌ BaseSwap, Compound III, Morpho — também ausentes em testnet

  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
