/**
 * Compound III (Comet) — ABIs mínimas usadas pelo discovery e calculator.
 *
 * Endereços canônicos por chain (Comet por base token):
 *   Base mainnet:
 *     - cUSDCv3 (USDC market): 0xb125E6687d4313864e53df431d5425969c15Eb2F
 *     - cWETHv3 (WETH market): 0x46e6b214b524310239732D51387075E0e70970bf
 *   Arbitrum mainnet:
 *     - cUSDCv3 (native USDC): 0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf
 *     - cUSDCEv3 (bridged):    0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA
 *     - cWETHv3:               0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486
 *   Optimism mainnet:
 *     - cUSDCv3: 0x2e44e174f7D53F0212823acC11C01A11d58c5bCB
 *     - cWETHv3: 0xE36A30D249f7761327fd973001A32010b521b6Fd
 */

export const COMET_ABI = [
  {
    type: 'function',
    name: 'isLiquidatable',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'baseToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'numAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  /**
   * Retorna info de um asset (collateral) pelo index.
   * Iteramos i=0..numAssets-1 pra montar a lista completa de collaterals do Comet.
   */
  {
    type: 'function',
    name: 'getAssetInfo',
    stateMutability: 'view',
    inputs: [{ type: 'uint8', name: 'i' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { type: 'uint8', name: 'offset' },
          { type: 'address', name: 'asset' },
          { type: 'address', name: 'priceFeed' },
          { type: 'uint64', name: 'scale' },
          { type: 'uint64', name: 'borrowCollateralFactor' },
          { type: 'uint64', name: 'liquidateCollateralFactor' },
          { type: 'uint64', name: 'liquidationFactor' },
          { type: 'uint128', name: 'supplyCap' },
        ],
      },
    ],
  },
  /**
   * Quanto collateral seria recebido por X de base token (já com desconto liquidation aplicado).
   * Critical pro calculator — substitui o "bonus" cálculo do Aave.
   */
  {
    type: 'function',
    name: 'quoteCollateral',
    stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'asset' },
      { type: 'uint256', name: 'baseAmount' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  /**
   * Saldo de um collateral específico que um borrower tem depositado.
   */
  {
    type: 'function',
    name: 'collateralBalanceOf',
    stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'account' },
      { type: 'address', name: 'asset' },
    ],
    outputs: [{ type: 'uint128' }],
  },
] as const;

/// Withdraw event do Comet — usado pra discovery via event scan.
export const COMET_WITHDRAW_EVENT_ABI = {
  type: 'event',
  name: 'Withdraw',
  inputs: [
    { type: 'address', name: 'src', indexed: true },
    { type: 'address', name: 'to', indexed: true },
    { type: 'uint256', name: 'amount', indexed: false },
  ],
} as const;
