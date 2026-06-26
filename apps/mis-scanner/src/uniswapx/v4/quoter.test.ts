import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, decodeFunctionData, type Address } from 'viem';
import { sortCurrencies, makeQuoteArgs, quoteUniswapV4, V4_QUOTER_ABI } from './quoter';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const WETH = '0x4200000000000000000000000000000000000006' as Address;

describe('sortCurrencies — ordem + direção V4', () => {
  it('WETH < USDC → currency0=WETH; WETH→USDC = zeroForOne', () => {
    const s = sortCurrencies(WETH, USDC);
    expect(s.currency0).toBe(WETH);
    expect(s.currency1).toBe(USDC);
    expect(s.zeroForOne).toBe(true);
  });

  it('USDC→WETH = !zeroForOne (currency0 continua WETH)', () => {
    const s = sortCurrencies(USDC, WETH);
    expect(s.currency0).toBe(WETH);
    expect(s.zeroForOne).toBe(false);
  });
});

describe('makeQuoteArgs — PoolKey', () => {
  it('monta poolKey com currencies ordenadas + config', () => {
    const a = makeQuoteArgs(WETH, USDC, 10n ** 18n, { fee: 500, tickSpacing: 10 });
    expect(a.poolKey.currency0).toBe(WETH);
    expect(a.poolKey.currency1).toBe(USDC);
    expect(a.poolKey.fee).toBe(500);
    expect(a.poolKey.tickSpacing).toBe(10);
    expect(a.poolKey.hooks).toBe('0x0000000000000000000000000000000000000000');
    expect(a.zeroForOne).toBe(true);
    expect(a.exactAmount).toBe(10n ** 18n);
  });
});

describe('quoteUniswapV4 — varre configs, pega a melhor (client mockado)', () => {
  // Mock: fee=500 cota 1568 USDC, fee=3000 cota 1569 (melhor); resto reverte.
  const mkClient = () =>
    ({
      call: async ({ data }: { data: `0x${string}` }) => {
        const decoded = decodeFunctionData({ abi: V4_QUOTER_ABI, data });
        const fee = (decoded.args as readonly any[])[0].poolKey.fee as number;
        const out = fee === 500 ? 1_568_000_000n : fee === 3000 ? 1_569_000_000n : null;
        if (out === null) throw new Error('pool inexistente'); // revert
        return { data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [out, 0n]) };
      },
    }) as never;

  it('retorna a maior saída + a poolKey vencedora', async () => {
    const q = await quoteUniswapV4({ client: mkClient(), tokenIn: WETH, tokenOut: USDC, amountIn: 10n ** 18n });
    expect(q).not.toBeNull();
    expect(q!.amountOut).toBe(1_569_000_000n); // fee=3000 venceu
    expect(q!.poolKey.fee).toBe(3000);
    expect(q!.zeroForOne).toBe(true);
  });

  it('null quando nenhuma config cota (todos os pools revertem)', async () => {
    const client = {
      call: async () => {
        throw new Error('revert');
      },
    } as never;
    const q = await quoteUniswapV4({ client, tokenIn: WETH, tokenOut: USDC, amountIn: 10n ** 18n });
    expect(q).toBeNull();
  });
});
