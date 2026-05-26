/**
 * ABI mínima dos contratos ZEUS v8.
 *
 * V8 refactor (2026-05-26): ZeusExecutor monolítico foi splittado em 3 contratos
 * pra resolver EIP-170 + permitir Compound/Morpho withBribe:
 *   - BribeManager.sol    (standalone) — paga bribe ao block.coinbase
 *   - ZeusLiquidator.sol  — Aave + Compound + Morpho liquidations (com/sem bribe)
 *   - ZeusArbExecutor.sol — Arbitrage (wallet/flashloan) + Backrun com bribe
 *
 * Pra evitar quebrar callers off-chain, ZEUS_EXECUTOR_ABI continua existindo como
 * UNION das funcs dos 2 executors — caller escolhe o `to:` certo (liquidatorAddress
 * vs arbExecutorAddress) baseado em qual função está chamando. ABIs específicos
 * (ZEUS_LIQUIDATOR_ABI + ZEUS_ARB_EXECUTOR_ABI + BRIBE_MANAGER_ABI) ficam exportados
 * pra decoders de evento e log filtering.
 *
 * Sincronização: manual com contracts/src/*.sol. Quando adicionarmos artifact build,
 * esses ABIs serão gerados automaticamente.
 */

/**
 * Union ABI — usado quando código off-chain encoda calldata e não distingue entre
 * Liquidator/ArbExecutor. Cobre tudo (executeArbitrage do ArbExec + executeLiquidation
 * do Liquidator + 3 *WithBribe variants, etc).
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

  // ════════ V7: bribe + backrun ════════

  // ─── executeFlashloanBackrun ───
  {
    type: 'function',
    name: 'executeFlashloanBackrun',
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
          {
            type: 'tuple',
            name: 'bribe',
            components: [
              { type: 'uint256', name: 'bribeBps' },
              { type: 'uint256', name: 'minBribeWei' },
              { type: 'uint256', name: 'bribeMaxBps' },
              { type: 'uint24', name: 'swapFeeTier' },
              { type: 'uint256', name: 'swapSlippageBps' },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },

  // ─── executeLiquidationWithBribe ───
  {
    type: 'function',
    name: 'executeLiquidationWithBribe',
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
      {
        type: 'tuple',
        name: 'bribe',
        components: [
          { type: 'uint256', name: 'bribeBps' },
          { type: 'uint256', name: 'minBribeWei' },
          { type: 'uint256', name: 'bribeMaxBps' },
          { type: 'uint24', name: 'swapFeeTier' },
          { type: 'uint256', name: 'swapSlippageBps' },
        ],
      },
    ],
    outputs: [],
  },

  // executeCompoundLiquidationWithBribe REMOVIDO em v7.1 (EIP-170 size limit).

  // executeMorphoLiquidationWithBribe REMOVIDO em v7.1 (EIP-170 size limit).
  // Morpho continua disponível via executeMorphoLiquidation (v6, sem bribe).

  // ─── V7 admin setters ───
  {
    type: 'function',
    name: 'setWeth',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address', name: 'weth' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setUniV3SwapRouter',
    stateMutability: 'nonpayable',
    inputs: [{ type: 'address', name: 'swapRouter' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'weth',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'uniV3SwapRouter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },

  // ─── V7 events ───
  {
    type: 'event',
    name: 'BribePaid',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'uint8', name: 'opType', indexed: true },
      { type: 'address', name: 'coinbase', indexed: true },
      { type: 'uint256', name: 'bribeNativeWei', indexed: false },
      { type: 'uint256', name: 'grossProfit', indexed: false },
      { type: 'uint256', name: 'netProfit', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BackrunExecuted',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'address', name: 'flashloanAsset', indexed: true },
      { type: 'address', name: 'profitToken', indexed: true },
      { type: 'uint256', name: 'flashloanAmount', indexed: false },
      { type: 'uint256', name: 'grossProfit', indexed: false },
      { type: 'uint256', name: 'bribeNativeWei', indexed: false },
      { type: 'uint256', name: 'netProfit', indexed: false },
    ],
  },

  // ─── V7 errors ───
  {
    type: 'error',
    name: 'BribeExceedsProfit',
    inputs: [
      { type: 'uint256', name: 'bribeNativeRequested' },
      { type: 'uint256', name: 'profitNativeAvailable' },
    ],
  },
  { type: 'error', name: 'InvalidBribeConfig', inputs: [] },
  { type: 'error', name: 'BribeSwapFailed', inputs: [] },
  { type: 'error', name: 'WethNotConfigured', inputs: [] },
  { type: 'error', name: 'SwapRouterNotConfigured', inputs: [] },
] as const;

/**
 * ABI do BribeManager (v8) — contrato standalone.
 * Útil pra decode de eventos BribePaid + filter de logs.
 */
export const BRIBE_MANAGER_ABI = [
  {
    type: 'function',
    name: 'validateConfig',
    stateMutability: 'pure',
    inputs: [
      {
        type: 'tuple',
        name: 'bribe',
        components: [
          { type: 'uint256', name: 'bribeBps' },
          { type: 'uint256', name: 'minBribeWei' },
          { type: 'uint256', name: 'bribeMaxBps' },
          { type: 'uint24', name: 'swapFeeTier' },
          { type: 'uint256', name: 'swapSlippageBps' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'pay',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'profitToken' },
      { type: 'uint256', name: 'grossProfit' },
      {
        type: 'tuple',
        name: 'bribe',
        components: [
          { type: 'uint256', name: 'bribeBps' },
          { type: 'uint256', name: 'minBribeWei' },
          { type: 'uint256', name: 'bribeMaxBps' },
          { type: 'uint24', name: 'swapFeeTier' },
          { type: 'uint256', name: 'swapSlippageBps' },
        ],
      },
      { type: 'address', name: 'weth' },
      { type: 'address', name: 'swapRouter' },
      { type: 'uint8', name: 'opType' },
      { type: 'address', name: 'operator' },
    ],
    outputs: [
      { type: 'uint256', name: 'bribeNativeWei' },
      { type: 'uint256', name: 'profitTokenConsumed' },
    ],
  },
  {
    type: 'event',
    name: 'BribePaid',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'uint8', name: 'opType', indexed: true },
      { type: 'address', name: 'coinbase', indexed: true },
      { type: 'uint256', name: 'bribeNativeWei', indexed: false },
      { type: 'uint256', name: 'grossProfit', indexed: false },
      { type: 'uint256', name: 'netProfit', indexed: false },
    ],
  },
  { type: 'error', name: 'InvalidBribeConfig', inputs: [] },
  {
    type: 'error',
    name: 'BribeExceedsProfit',
    inputs: [
      { type: 'uint256', name: 'bribeNativeRequested' },
      { type: 'uint256', name: 'profitNativeAvailable' },
    ],
  },
  { type: 'error', name: 'BribeSwapFailed', inputs: [] },
  { type: 'error', name: 'WethNotConfigured', inputs: [] },
  { type: 'error', name: 'SwapRouterNotConfigured', inputs: [] },
] as const;

/**
 * Alias semântico — ZEUS_LIQUIDATOR_ABI e ZEUS_ARB_EXECUTOR_ABI ambos apontam pro
 * mesmo ZEUS_EXECUTOR_ABI (union). Diferenciação é feita pelo `to:` address que
 * o caller escolhe (liquidatorAddress vs arbExecutorAddress).
 *
 * Em v9 podemos splittar fisicamente — por enquanto union basta pra encode/decode.
 */
export const ZEUS_LIQUIDATOR_ABI = ZEUS_EXECUTOR_ABI;
export const ZEUS_ARB_EXECUTOR_ABI = ZEUS_EXECUTOR_ABI;
