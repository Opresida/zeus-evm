import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import { DexType } from '@zeus-evm/dex-adapters';

import { buildPreLiquidationTx } from './builder';
import { ZEUS_MORPHO_PRELIQUIDATOR_ABI } from './abi';
import type { PrePosition } from './types';
import type { PrePlan } from './math';

const PRE_LIQ = '0xa7272aFc21f9C321024ED93892a1abfeb621C374' as Address;
const LOAN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address; // USDC
const COLL = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as Address; // cbBTC
const BORROWER = '0xaEC4EE9A108304fCc5Cdc323d8A2A1D331C342b7' as Address;
const RECEIVER = '0xE060821b253ec9dad4BDe139c5661Bc07A6AcBB4' as Address;
const EXECUTOR = '0x1111111111111111111111111111111111111111' as Address;
const SWAP_ROUTER = '0x2222222222222222222222222222222222222222' as Address;

const position = {
  preLiquidation: PRE_LIQ,
  marketId: '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836',
  borrower: BORROWER,
  loanToken: LOAN,
  loanTokenSymbol: 'USDC',
  loanTokenDecimals: 6,
  collateralToken: COLL,
  collateralTokenDecimals: 8,
  preLiquidationOracle: '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9',
} as unknown as PrePosition;

const plan = { repaidShares: 5_000_000_000_000n, expectedSeizedCollateral: 1_500_000n } as unknown as PrePlan;

const chainConfig = { uniswapV3: { swapRouter02: SWAP_ROUTER } } as never;
const quote = { dex: DexType.UniswapV3, extraData: '0x0001f4', router: undefined } as never;

describe('buildPreLiquidationTx', () => {
  it('encoda executePreMorphoLiquidation: modo por-shares + swap amountIn=0 + slippage', () => {
    const expectedSwapOutput = 1_000_000_000n; // 1000 USDC
    const built = buildPreLiquidationTx(position, plan, {
      executorAddress: EXECUTOR,
      chainConfig,
      profitReceiver: RECEIVER,
      slippageBps: 100, // 1%
      quote,
      expectedSwapOutput,
      minProfitWei: 7_000_000n,
    });

    expect(built.to).toBe(EXECUTOR);

    const decoded = decodeFunctionData({ abi: ZEUS_MORPHO_PRELIQUIDATOR_ABI, data: built.data });
    expect(decoded.functionName).toBe('executePreMorphoLiquidation');
    const p = (decoded.args as readonly any[])[0];

    // Doutrina: modo por-shares → seizedAssets = 0.
    expect(p.seizedAssets).toBe(0n);
    expect(p.repaidShares).toBe(plan.repaidShares);
    expect(p.preLiquidation).toBe(PRE_LIQ);
    expect(p.loanToken.toLowerCase()).toBe(LOAN.toLowerCase());
    expect(p.collateralToken.toLowerCase()).toBe(COLL.toLowerCase());
    expect(p.profitReceiver).toBe(RECEIVER);
    expect(p.minProfitWei).toBe(7_000_000n);

    // swapStep único: vende TODO o colateral seizado (amountIn=0=saldo) → loanToken.
    expect(p.swapSteps.length).toBe(1);
    const step = p.swapSteps[0];
    expect(step.amountIn).toBe(0n);
    expect(step.tokenIn.toLowerCase()).toBe(COLL.toLowerCase());
    expect(step.tokenOut.toLowerCase()).toBe(LOAN.toLowerCase());
    expect(step.router).toBe(SWAP_ROUTER); // quote.router ausente → canônico UniV3
    expect(step.dexType).toBe(DexType.UniswapV3);
    // minAmountOut = expected × (1 - 1%) = 990 USDC.
    expect(step.minAmountOut).toBe(990_000_000n);
  });

  it('usa quote.router quando presente (fork UniV3)', () => {
    const forkRouter = '0x3333333333333333333333333333333333333333' as Address;
    const built = buildPreLiquidationTx(position, plan, {
      executorAddress: EXECUTOR,
      chainConfig,
      profitReceiver: RECEIVER,
      slippageBps: 50,
      quote: { dex: DexType.UniswapV3, extraData: '0x000bb8', router: forkRouter } as never,
      expectedSwapOutput: 1_000_000_000n,
      minProfitWei: 0n,
    });
    const decoded = decodeFunctionData({ abi: ZEUS_MORPHO_PRELIQUIDATOR_ABI, data: built.data });
    const step = (decoded.args as readonly any[])[0].swapSteps[0];
    expect(step.router).toBe(forkRouter);
  });
});
