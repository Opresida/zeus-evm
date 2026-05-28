/**
 * Polygon PoS mainnet (chain id 137) — endereços de protocolos chave.
 *
 * Aave V3: maior mercado do Aave fora da mainnet — TVL alto, muitos borrowers.
 * Edge esperada (Motor 1): boa — universo grande, competição moderada.
 *
 * Native token: POL (renomeado de MATIC em set/2024), 18 decimais.
 *
 * Fontes (verificadas 2026-05-28):
 *  - Aave V3 core + tokens: github.com/bgd-labs/aave-address-book → AaveV3Polygon.sol
 *    (POOL/PROVIDER/DATA_PROVIDER iguais a Arbitrum/Optimism; ORACLE específico de Polygon;
 *     tokens = underlyings dos reserves do Aave Polygon — exatamente o universo do Motor 1)
 *  - Uniswap V3: docs.uniswap.org/contracts/v3/reference/deployments (factory/quoter/router/NFT
 *    são determinísticos — idênticos a Ethereum/Arb/OP)
 *  - Multicall3: 0xcA11... (universal, mesma em toda chain)
 *
 * NOTA: Polygon NÃO tem Aerodrome (isso é Base). Pra Motor 2 (arb cross-DEX) precisaria
 * de adapter de DEX nativo (QuickSwap/SushiSwap). Pra Motor 1 (liquidations), Uniswap V3
 * basta pra perna de swap. Compound III em Polygon existe mas fica pendente (verificar addr).
 */

import type { ChainConfig } from './types';

export const POLYGON_MAINNET: ChainConfig = {
  chainId: 137,
  name: 'Polygon PoS',
  shortName: 'polygon',
  nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
  blockExplorer: 'https://polygonscan.com',

  tokens: {
    POL:    '0x0000000000000000000000000000000000000000', // native sentinel
    WPOL:   '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // wrapped native (ex-WMATIC)
    WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // alias legado (mesmo contrato do WPOL)
    WETH:   '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', // bridged WETH
    USDC:   '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Native USDC (Circle)
    'USDC.e': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // bridged legacy
    USDT:   '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    DAI:    '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    WBTC:   '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    wstETH: '0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD', // LSD (tese sub-servido)
  },

  // ─── Aave V3 (POOL/PROVIDER/DATA_PROVIDER iguais a Arb/OP — CREATE2 deterministic) ───
  aave: {
    poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    oracle: '0xb023e699F5a33916Ea823A16485e259257cA8Bd1',
    aaveDataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
  },

  // ─── Uniswap V3 (endereços determinísticos — mesmos de Ethereum/Arb/OP) ───
  uniswapV3: {
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    nftPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    feeTiers: [100, 500, 3000, 10000] as const,
  },

  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
