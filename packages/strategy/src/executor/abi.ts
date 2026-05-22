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
