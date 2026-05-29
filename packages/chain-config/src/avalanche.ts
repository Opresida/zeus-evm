/**
 * Avalanche C-Chain mainnet (chain id 43114) — endereços de protocolos chave.
 *
 * Aave V3: mercado relevante (~$500M-1B TVL). Edge esperada (Motor 1): boa.
 *
 * Native token: AVAX, 18 decimais. Wrapped = WAVAX.
 *
 * Fontes (verificadas 2026-05-29):
 *  - Aave V3 core + tokens: github.com/bgd-labs/aave-address-book → AaveV3Avalanche.sol
 *    (POOL/PROVIDER/DATA_PROVIDER iguais a Polygon/Arb/OP; ORACLE específico de Avalanche;
 *     tokens = underlyings dos reserves do Aave Avalanche)
 *  - Uniswap V3: github.com/Uniswap/sdks → sdk-core AVALANCHE_ADDRESSES (NÃO-determinísticos —
 *    deploy de governança separado, endereços próprios da Avalanche)
 *  - Multicall3: 0xcA11... (universal)
 *
 * NOTA: Avalanche NÃO tem Aerodrome. DEX nativo dominante é Trader Joe (AMM "Liquidity Book",
 * modelo diferente → adapter novo). Pra Motor 1 (liquidations), Uniswap V3 basta pra swap.
 * Pra Motor 2 (arb cross-DEX) precisa do adapter Trader Joe (camada 2, fora deste escopo).
 */

import type { ChainConfig } from './types';

export const AVALANCHE_MAINNET: ChainConfig = {
  chainId: 43114,
  name: 'Avalanche C-Chain',
  shortName: 'avalanche',
  nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
  blockExplorer: 'https://snowtrace.io',

  tokens: {
    AVAX:    '0x0000000000000000000000000000000000000000', // native sentinel
    WAVAX:   '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // wrapped native
    'WETH.e': '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', // bridged WETH (Avalanche bridge)
    'WBTC.e': '0x50b7545627a5162F82A992c33b87aDc75187B218',
    'DAI.e':  '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
    USDC:    '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Native USDC (Circle)
    USDT:    '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', // USDt
    sAVAX:   '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', // LSD staked AVAX (tese sub-servido)
  },

  // ─── Aave V3 (PROVIDER/POOL/DATA_PROVIDER iguais a Polygon/Arb/OP; oracle específico) ───
  aave: {
    poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    oracle: '0xEBd36016B3eD09D4693Ed4251c67Bd858c3c7C9C',
    aaveDataProvider: '0x243Aa95cAC2a25651eda86e80bEe66114413c43b',
  },

  // ─── Uniswap V3 (endereços ESPECÍFICOS da Avalanche — NÃO determinísticos) ───
  uniswapV3: {
    factory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
    swapRouter02: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    quoterV2: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    nftPositionManager: '0x655C406EBFa14EE2006250925e54ec43AD184f8B',
    feeTiers: [100, 500, 3000, 10000] as const,
  },

  // ─── Trader Joe v2.2 Liquidity Book (DEX nativo — Motor 2 cross-DEX) ───
  // Fonte: docs.lfj.gg (verificado 2026-05-29). LBQuoter não usado — quote via LBPair.getSwapOut (view).
  traderJoe: {
    lbFactory: '0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c',
    lbRouter: '0x18556DA13313f3532c54711497A8FedAC273220E',
  },

  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
};
