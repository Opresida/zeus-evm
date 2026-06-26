/**
 * Motor 2 / Filler UniswapX — ABI do nosso ZeusUniswapXFiller (encode do executeFill) + reactors da Base.
 */

import type { Address } from 'viem';

/** Reactors UniswapX na Base (confirmados on-chain no recon). */
export const UNISWAPX_REACTORS_BASE = {
  v2DutchOrder: '0x000000001Ec5656dcdB24D90DFa42742738De729' as Address,
  v3DutchOrder: '0x000000008a8330B5d1F43A62Bf4C673A49f27ba0' as Address,
} as const;

/** SwapStep + UniswapXFillParams + entry do nosso ZeusUniswapXFiller (encode da tx). */
export const ZEUS_UNISWAPX_FILLER_ABI = [
  {
    type: 'function',
    name: 'executeFill',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'reactor' },
          {
            type: 'tuple',
            name: 'order',
            components: [
              { type: 'bytes', name: 'order' },
              { type: 'bytes', name: 'sig' },
            ],
          },
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
          { type: 'address', name: 'profitToken' },
          { type: 'uint256', name: 'minProfitWei' },
          { type: 'address', name: 'profitReceiver' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'UniswapXFillExecuted',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'address', name: 'reactor', indexed: true },
      { type: 'address', name: 'profitToken', indexed: true },
      { type: 'uint256', name: 'profit', indexed: false },
    ],
  },
] as const;
