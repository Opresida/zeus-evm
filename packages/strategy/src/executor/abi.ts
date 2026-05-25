/**
 * ABI mínima do ZeusExecutor — só as funções que o detector precisa chamar.
 * Mantida sincronizada manualmente com contracts/src/ZeusExecutor.sol.
 *
 * Quando adicionarmos build pipeline, esse ABI será gerado de forge build artifact.
 */

export const ZEUS_EXECUTOR_ABI = [
  // ─── executeArbitrage (modalidade capital próprio) ───
  {
    type: 'function',
    name: 'executeArbitrage',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          {
            type: 'tuple[]',
            name: 'steps',
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
          { type: 'address', name: 'profitToken' },
          { type: 'address', name: 'profitReceiver' },
        ],
      },
    ],
    outputs: [],
  },
  // ─── executeFlashloanArbitrage (modalidade flashloan Aave V3) ───
  {
    type: 'function',
    name: 'executeFlashloanArbitrage',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'flashloanAsset' },
      { type: 'uint256', name: 'flashloanAmount' },
      {
        type: 'tuple',
        name: 'params',
        components: [
          {
            type: 'tuple[]',
            name: 'steps',
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
          { type: 'address', name: 'profitToken' },
          { type: 'address', name: 'profitReceiver' },
        ],
      },
    ],
    outputs: [],
  },
  // ─── executeLiquidation (modalidade liquidação Aave V3 + flashloan) ───
  {
    type: 'function',
    name: 'executeLiquidation',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'user' },
          { type: 'address', name: 'collateralAsset' },
          { type: 'address', name: 'debtAsset' },
          { type: 'uint256', name: 'debtToCover' },
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
        ],
      },
    ],
    outputs: [],
  },
  // ─── executeCompoundLiquidation (modalidade liquidação Compound III + flashloan Aave V3) ───
  {
    type: 'function',
    name: 'executeCompoundLiquidation',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'comet' },
          { type: 'address', name: 'borrower' },
          { type: 'address', name: 'collateralAsset' },
          { type: 'uint256', name: 'baseAmount' },
          { type: 'uint256', name: 'minCollateralReceived' },
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
        ],
      },
    ],
    outputs: [],
  },
  // ─── executeMorphoLiquidation (modalidade liquidação Morpho Blue + flashloan Aave) ───
  {
    type: 'function',
    name: 'executeMorphoLiquidation',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'morpho' },
          { type: 'address', name: 'loanToken' },
          { type: 'address', name: 'collateralToken' },
          { type: 'address', name: 'oracle' },
          { type: 'address', name: 'irm' },
          { type: 'uint256', name: 'lltv' },
          { type: 'address', name: 'borrower' },
          { type: 'uint256', name: 'seizedAssets' },
          { type: 'uint256', name: 'repaidShares' },
          // M-02 fix (2026-05-25): flashloanAmount explícito em wei do loanToken
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
        ],
      },
    ],
    outputs: [],
  },
  // ─── Admin: setMaxTradePerToken (H-02 fix, per-token cap) ───
  {
    type: 'function',
    name: 'setMaxTradePerToken',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'token' },
      { type: 'uint256', name: 'newMax' },
    ],
    outputs: [],
  },
  // ─── View: getMaxTradeFor (resolve cap aplicável a um token) ───
  {
    type: 'function',
    name: 'getMaxTradeFor',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'token' }],
    outputs: [{ type: 'uint256' }],
  },
  // ─── View: maxTradeWei (fallback global) ───
  {
    type: 'function',
    name: 'maxTradeWei',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  // ─── View: isKilled ───
  {
    type: 'function',
    name: 'isKilled',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  // ─── View: isOperator ───
  {
    type: 'function',
    name: 'isOperator',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'bool' }],
  },
  // ─── Eventos (pra decode de logs futuros) ───
  {
    type: 'event',
    name: 'ArbitrageExecuted',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'address', name: 'profitToken', indexed: true },
      { type: 'uint256', name: 'profit', indexed: false },
      { type: 'uint256', name: 'swapsCount', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FlashloanArbitrageExecuted',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'address', name: 'flashloanAsset', indexed: true },
      { type: 'uint256', name: 'flashloanAmount', indexed: false },
      { type: 'uint256', name: 'flashloanFee', indexed: false },
      { type: 'address', name: 'profitToken', indexed: true },
      { type: 'uint256', name: 'profit', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LiquidationExecuted',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'address', name: 'user', indexed: true },
      { type: 'address', name: 'collateralAsset', indexed: true },
      { type: 'address', name: 'debtAsset', indexed: false },
      { type: 'uint256', name: 'debtCovered', indexed: false },
      { type: 'uint256', name: 'collateralReceived', indexed: false },
      { type: 'uint256', name: 'profit', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CompoundLiquidationExecuted',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'address', name: 'comet', indexed: true },
      { type: 'address', name: 'borrower', indexed: true },
      { type: 'address', name: 'collateralAsset', indexed: false },
      { type: 'uint256', name: 'baseAmount', indexed: false },
      { type: 'uint256', name: 'collateralReceived', indexed: false },
      { type: 'uint256', name: 'profit', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MorphoLiquidationExecuted',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'address', name: 'borrower', indexed: true },
      { type: 'address', name: 'collateralToken', indexed: true },
      { type: 'address', name: 'loanToken', indexed: false },
      { type: 'uint256', name: 'assetsLiquidated', indexed: false },
      { type: 'uint256', name: 'collateralReceived', indexed: false },
      { type: 'uint256', name: 'profit', indexed: false },
    ],
  },
  // H-02 fix event
  {
    type: 'event',
    name: 'MaxTradePerTokenUpdated',
    inputs: [
      { type: 'address', name: 'token', indexed: true },
      { type: 'uint256', name: 'oldValue', indexed: false },
      { type: 'uint256', name: 'newValue', indexed: false },
    ],
  },
  // ─── Custom errors (pra decode de revert reasons) ───
  { type: 'error', name: 'NotAuthorized', inputs: [] },
  { type: 'error', name: 'BotKilled', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientProfit',
    inputs: [
      { type: 'uint256', name: 'actual' },
      { type: 'uint256', name: 'required' },
    ],
  },
  { type: 'error', name: 'SwapFailed', inputs: [{ type: 'uint256', name: 'stepIndex' }] },
  { type: 'error', name: 'InvalidDexType', inputs: [{ type: 'uint8', name: 'dexType' }] },
  {
    type: 'error',
    name: 'FlashloanRepayShortfall',
    inputs: [
      { type: 'uint256', name: 'available' },
      { type: 'uint256', name: 'required' },
    ],
  },
  {
    type: 'error',
    name: 'TradeTooLarge',
    inputs: [
      { type: 'uint256', name: 'amount' },
      { type: 'uint256', name: 'max' },
    ],
  },
  { type: 'error', name: 'EmptySteps', inputs: [] },
  { type: 'error', name: 'InvalidCaller', inputs: [] },
] as const;
