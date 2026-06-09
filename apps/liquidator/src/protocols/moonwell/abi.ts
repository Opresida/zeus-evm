/**
 * Moonwell (Compound V2 fork) — ABIs pro discovery + liquidation.
 *
 * Comptroller (singleton) + mTokens (1 por asset). Liquidation via
 * ZeusMoonwellLiquidator (contrato SEPARADO, endereço próprio).
 */

/** Comptroller — discovery (shortfall) + parâmetros de liquidação. */
export const COMPTROLLER_ABI = [
  {
    type: 'function',
    name: 'getAccountLiquidity',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [
      { type: 'uint256', name: 'error' },
      { type: 'uint256', name: 'liquidity' },
      { type: 'uint256', name: 'shortfall' },
    ],
  },
  {
    type: 'function',
    name: 'getAllMarkets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getAssetsIn',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'closeFactorMantissa',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'liquidationIncentiveMantissa',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** mToken (MErc20) — reads de position + metadata. */
export const MTOKEN_ABI = [
  {
    type: 'function',
    name: 'underlying',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'borrowBalanceStored',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    // (error, mTokenBalance, borrowBalance, exchangeRateMantissa)
    type: 'function',
    name: 'getAccountSnapshot',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const;

/**
 * Evento Borrow do mToken — discovery on-chain de borrowers.
 *   event Borrow(address borrower, uint borrowAmount, uint accountBorrows, uint totalBorrows);
 */
export const MTOKEN_BORROW_EVENT_ABI = {
  type: 'event',
  name: 'Borrow',
  inputs: [
    { type: 'address', name: 'borrower', indexed: false },
    { type: 'uint256', name: 'borrowAmount', indexed: false },
    { type: 'uint256', name: 'accountBorrows', indexed: false },
    { type: 'uint256', name: 'totalBorrows', indexed: false },
  ],
} as const;

/** executeMoonwellLiquidation do ZeusMoonwellLiquidator (contrato separado). */
export const ZEUS_MOONWELL_LIQUIDATOR_ABI = [
  {
    type: 'function',
    name: 'executeMoonwellLiquidation',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'mTokenBorrowed' },
          { type: 'address', name: 'borrowedUnderlying' },
          { type: 'address', name: 'mTokenCollateral' },
          { type: 'address', name: 'collateralUnderlying' },
          { type: 'address', name: 'borrower' },
          { type: 'uint256', name: 'repayAmount' },
          { type: 'uint256', name: 'flashloanAmount' },
          {
            type: 'tuple[]',
            name: 'swapSteps',
            components: [
              { type: 'address', name: 'router' },
              { type: 'address', name: 'tokenIn' },
              { type: 'address', name: 'tokenOut' },
              { type: 'uint256', name: 'amountIn' },
              { type: 'uint256', name: 'minAmountOut' },
              { type: 'uint8', name: 'dexType' },
              { type: 'bytes', name: 'extraData' },
            ],
          },
          { type: 'uint256', name: 'minProfitWei' },
          { type: 'address', name: 'profitReceiver' },
          { type: 'uint8', name: 'flashSource' },
        ],
      },
    ],
    outputs: [],
  },
] as const;
