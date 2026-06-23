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
    VIRTUAL: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', // Virtuals Protocol (AI agents)
  },

  // ─── Aave V3 ───
  aave: {
    poolAddressesProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    oracle: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156',
    aaveDataProvider: '0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad',
  },

  // ─── Aave V3 forks (Doutrina: mercados sub-servidos) ───
  // Seamless Protocol — fork direto do Aave V3 em Base, menos liquidators ativos.
  // Endereços oficiais: https://docs.seamlessprotocol.com/technical/contract-addresses
  aaveForks: [
    {
      label: 'seamless',
      poolAddressesProvider: '0x0E02EB705be325407707662C6f6d3466E939f3a0',
      pool: '0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7',
      oracle: '0xFDd4e83890BCcd1fbF9b10d71a5cc0a738753b01',
      aaveDataProvider: '0x2A0979257105834789bC6b9E1B6d59A8c0acf003',
    },
  ],

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

  // ─── DEXes UniswapV2-compatíveis (Motor 2 — execução via DexType.UniswapV2) ───
  // ✅ VERIFICADO on-chain 2026-06-23 (router/factory têm código + factory.getPair(WETH,USDC)!=0).
  //    Adicionar um fork UniV2 novo = SÓ mais uma linha aqui (UniswapV2Lib já cobre on-chain; sem redeploy).
  //    REMOVIDOS na verificação: dackieswap-v2 (router 0x195FBc…dd457 sem bytecode = morto) e
  //    rocketswap (router OK, mas SEM par dos curados — WETH/USDC, cbETH/WETH, AERO/WETH, cbETH/USDC,
  //    DAI/USDC, USDC/USDbC todos inexistentes → era só custo de RPC). Re-adicionar só com par vivo.
  univ2Dexes: [
    { name: 'baseswap',      router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB' },
    { name: 'alienbase',     router: '0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7', factory: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7' },
    { name: 'swapbased',     router: '0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066', factory: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300' },
    { name: 'pancakeswap-v2', router: '0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb', factory: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E' },
    { name: 'sushiswap-v2',   router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891', factory: '0x71524B4f93c58fcbF659783284E38825f0622859' },
  ],

  // ─── Forks Uniswap V3 (Motor 2) ───
  // Pricing reusa a trilha UniV3 (slot0/QuoterV2). A EXECUÇÃO depende do `routerStyle`:
  //   'uniswapV3' → DexType.UniswapV3 (struct SEM deadline); 'pancakeV3' → DexType.PancakeV3
  //   (struct exactInputSingle COM deadline).
  // ✅ VERIFICADO on-chain via fork test (ZeusArbExecutorDex.fork.t.sol): tanto Pancake QUANTO
  //    Sushi na Base têm SwapRouter com `deadline` na struct → ambos routerStyle='pancakeV3'.
  //    (Sushi NÃO é SwapRouter02 aqui — o swap reverte sem o deadline; confirmado no fork.)
  //    Pancake V3 usa feeTiers [100, 500, 2500, 10000] (2500 no lugar de 3000); Sushi usa os padrão.
  univ3Forks: [
    {
      name: 'pancakeswap-v3',
      routerStyle: 'pancakeV3',
      factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
      quoterV2: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
      swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
      feeTiers: [100, 500, 2500, 10000] as const,
    },
    {
      name: 'sushiswap-v3',
      routerStyle: 'pancakeV3', // SwapRouter da Sushi na Base tem deadline (verificado no fork)
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      quoterV2: '0xb1E835Dc2785b52265711e17fCCb0fd018226a6e',
      swapRouter: '0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f',
      feeTiers: [100, 500, 3000, 10000] as const,
    },
  ],

  // ─── Aerodrome Slipstream (concentrated liquidity — execução via DexType.Slipstream) ───
  // ✅ VERIFICADO on-chain 2026-06-23 (factory/quoter/swapRouter têm código; pools WETH/USDC em
  //    tickSpacing 1/50/100/200) + swap real no fork test (SlipstreamLib).
  //    tickSpacings Slipstream Base: 1 (stable), 50/100/200 (volatile tiers), 2000 (exótico).
  slipstream: {
    factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
    quoter: '0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0',
    swapRouter: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
    tickSpacings: [1, 50, 100, 200, 2000] as const,
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

  // ─── Balancer V2 Vault (fonte de flashloan 0% — endereço canônico em toda chain EVM) ───
  balancer: {
    vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  },

  // ─── Moonwell (Compound V2 fork — Doutrina: mercado sub-servido) ───
  // Comptroller oficial Base: https://docs.moonwell.fi/moonwell/protocol-information/contracts
  moonwell: {
    comptroller: '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C',
  },

  // ─── Multicall ───
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
