/**
 * Garante que a ABI tem as funções WithBribe de Compound/Morpho (voltaram no split v8) e
 * que o encoding funciona — ou seja, o lado TS consegue chamar o que o contrato expõe.
 */

import { describe, expect, it } from 'vitest';
import { encodeFunctionData, toFunctionSelector, zeroAddress } from 'viem';
import { ZEUS_EXECUTOR_ABI } from '@zeus-evm/strategy';

const swapSteps = [
  {
    router: zeroAddress,
    tokenIn: zeroAddress,
    tokenOut: zeroAddress,
    amountIn: 0n,
    minAmountOut: 0n,
    dexType: 1,
    extraData: '0x' as `0x${string}`,
  },
];
const bribe = {
  bribeBps: 5000n,
  minBribeWei: 0n,
  bribeMaxBps: 9500n,
  swapFeeTier: 500,
  swapSlippageBps: 50n,
};

describe('ABI — variantes WithBribe de Compound/Morpho (re-adicionadas no v8)', () => {
  it('a ABI contém as 2 funções', () => {
    const names = ZEUS_EXECUTOR_ABI.filter((x) => x.type === 'function').map((x) => (x as { name: string }).name);
    expect(names).toContain('executeCompoundLiquidationWithBribe');
    expect(names).toContain('executeMorphoLiquidationWithBribe');
  });

  it('encoda executeCompoundLiquidationWithBribe (params + bribe)', () => {
    const params = {
      comet: zeroAddress, borrower: zeroAddress, collateralAsset: zeroAddress,
      baseAmount: 1000n, minCollateralReceived: 0n, swapSteps,
      minProfitWei: 0n, profitReceiver: zeroAddress, flashSource: 0,
    };
    const data = encodeFunctionData({ abi: ZEUS_EXECUTOR_ABI, functionName: 'executeCompoundLiquidationWithBribe', args: [params, bribe] });
    expect(data.startsWith('0x')).toBe(true);
    // selector da WithBribe difere da versão sem bribe
    const withBribeSel = data.slice(0, 10);
    const plain = encodeFunctionData({ abi: ZEUS_EXECUTOR_ABI, functionName: 'executeCompoundLiquidation', args: [params] });
    expect(withBribeSel).not.toBe(plain.slice(0, 10));
  });

  it('encoda executeMorphoLiquidationWithBribe (params + bribe)', () => {
    const params = {
      morpho: zeroAddress, loanToken: zeroAddress, collateralToken: zeroAddress,
      oracle: zeroAddress, irm: zeroAddress, lltv: 860000000000000000n, borrower: zeroAddress,
      seizedAssets: 0n, repaidShares: 0n, flashloanAmount: 1000n, swapSteps,
      minProfitWei: 0n, profitReceiver: zeroAddress, flashSource: 1,
    };
    const data = encodeFunctionData({ abi: ZEUS_EXECUTOR_ABI, functionName: 'executeMorphoLiquidationWithBribe', args: [params, bribe] });
    expect(data.startsWith('0x')).toBe(true);
    // selector estável (4 bytes) — confirma assinatura bem-formada
    expect(data.slice(0, 10)).toMatch(/^0x[0-9a-f]{8}$/);
    expect(toFunctionSelector('executeMorphoLiquidationWithBribe((address,address,address,address,address,uint256,address,uint256,uint256,uint256,(address,address,address,uint256,uint256,uint8,bytes)[],uint256,address,uint8),(uint256,uint256,uint256,uint24,uint256))')).toBe(data.slice(0, 10));
  });
});
