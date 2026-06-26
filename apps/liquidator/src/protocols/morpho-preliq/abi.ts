/**
 * Morpho PRE-liquidation — ABIs off-chain (viem).
 *
 * Reusa os reads do Morpho singleton (`../morpho/abi`: position/market/idToMarketParams + oracle) e
 * adiciona: o contrato PreLiquidation por-mercado, o evento da Factory (discovery), `isAuthorized` do
 * Morpho (gate de autorização), e o ABI do NOSSO `ZeusMorphoPreLiquidator` (encode da tx).
 *
 * Factory Base (Fase 0): 0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef
 */

export { MORPHO_ABI, MORPHO_ORACLE_ABI, MORPHO_BORROW_EVENT_ABI } from '../morpho/abi';

/** Contrato PreLiquidation por-mercado (morpho-org/pre-liquidation). */
export const PRE_LIQUIDATION_ABI = [
  {
    type: 'function',
    name: 'preLiquidate',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'address', name: 'borrower' },
      { type: 'uint256', name: 'seizedAssets' },
      { type: 'uint256', name: 'repaidShares' },
      { type: 'bytes', name: 'data' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'preLiquidationParams',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        type: 'tuple',
        components: [
          { type: 'uint256', name: 'preLltv' },
          { type: 'uint256', name: 'preLCF1' },
          { type: 'uint256', name: 'preLCF2' },
          { type: 'uint256', name: 'preLIF1' },
          { type: 'uint256', name: 'preLIF2' },
          { type: 'address', name: 'preLiquidationOracle' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'marketParams',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [
      {
        type: 'tuple',
        components: [
          { type: 'address', name: 'loanToken' },
          { type: 'address', name: 'collateralToken' },
          { type: 'address', name: 'oracle' },
          { type: 'address', name: 'irm' },
          { type: 'uint256', name: 'lltv' },
        ],
      },
    ],
  },
] as const;

/**
 * Evento da PreLiquidationFactory:
 *   event CreatePreLiquidation(address indexed preLiquidation, Id id, PreLiquidationParams preLiquidationParams);
 */
export const CREATE_PRE_LIQUIDATION_EVENT_ABI = {
  type: 'event',
  name: 'CreatePreLiquidation',
  inputs: [
    { type: 'address', name: 'preLiquidation', indexed: true },
    { type: 'bytes32', name: 'id', indexed: false },
    {
      type: 'tuple',
      name: 'preLiquidationParams',
      indexed: false,
      components: [
        { type: 'uint256', name: 'preLltv' },
        { type: 'uint256', name: 'preLCF1' },
        { type: 'uint256', name: 'preLCF2' },
        { type: 'uint256', name: 'preLIF1' },
        { type: 'uint256', name: 'preLIF2' },
        { type: 'address', name: 'preLiquidationOracle' },
      ],
    },
  ],
} as const;

/** `Morpho.isAuthorized(authorizer, authorized)` — a pré-liquidação exige o borrower autorizar o PreLiquidation. */
export const MORPHO_IS_AUTHORIZED_ABI = [
  {
    type: 'function',
    name: 'isAuthorized',
    stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'authorizer' },
      { type: 'address', name: 'authorized' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/** SwapStep + PreMorphoLiquidationParams + entry do NOSSO ZeusMorphoPreLiquidator (encode da tx). */
export const ZEUS_MORPHO_PRELIQUIDATOR_ABI = [
  {
    type: 'function',
    name: 'executePreMorphoLiquidation',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'preLiquidation' },
          { type: 'address', name: 'loanToken' },
          { type: 'address', name: 'collateralToken' },
          { type: 'address', name: 'borrower' },
          { type: 'uint256', name: 'seizedAssets' },
          { type: 'uint256', name: 'repaidShares' },
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
  {
    type: 'event',
    name: 'PreMorphoLiquidationExecuted',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'address', name: 'preLiquidation', indexed: true },
      { type: 'address', name: 'borrower', indexed: true },
      { type: 'address', name: 'loanToken', indexed: false },
      { type: 'uint256', name: 'repaidAssets', indexed: false },
      { type: 'uint256', name: 'profit', indexed: false },
    ],
  },
] as const;
