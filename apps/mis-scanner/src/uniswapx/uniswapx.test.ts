import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Address } from 'viem';
import { DexType } from '@zeus-evm/dex-adapters';

import { evaluateFill } from './evaluator';
import { buildFillTx } from './builder';
import { fetchOpenOrders } from './orderFeed';
import { ZEUS_UNISWAPX_FILLER_ABI, UNISWAPX_REACTORS_BASE } from './abi';
import type { NormalizedOrder } from './types';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const WETH = '0x4200000000000000000000000000000000000006' as Address;
const VVV = '0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf' as Address;
const SWAPPER = '0x1111111111111111111111111111111111111111' as Address;
const FILLER = '0x2222222222222222222222222222222222222222' as Address;
const RECEIVER = '0x3333333333333333333333333333333333333333' as Address;

function order(partial: Partial<NormalizedOrder> = {}): NormalizedOrder {
  return {
    reactor: UNISWAPX_REACTORS_BASE.v2DutchOrder,
    orderHash: '0xabc',
    swapper: SWAPPER,
    input: { token: USDC, amount: 3_000_000_000n }, // 3000 USDC
    outputs: [{ token: WETH, amount: 1_000_000_000_000_000_000n, recipient: SWAPPER }], // quer 1 WETH
    deadline: 2_000_000_000,
    signedOrder: '0xdead',
    signature: '0xbeef',
    ...partial,
  };
}

const usdPrice: Record<string, number> = { [WETH.toLowerCase()]: 3000, [USDC.toLowerCase()]: 1 };
const estimateUsd = (token: Address, amountWei: bigint): number | null => {
  const p = usdPrice[token.toLowerCase()];
  if (p === undefined) return null;
  const dec = token.toLowerCase() === USDC.toLowerCase() ? 6 : 18;
  return (Number(amountWei) / 10 ** dec) * p;
};

describe('evaluateFill — economia do fill', () => {
  const base = { estimateUsd, minProfitUsd: 1, gasCostUsd: 0.05, nowSec: 1_000_000_000 };

  it('lucra quando o sourcing entrega mais que a saída requerida', async () => {
    // quote: 3000 USDC compra 1.01 WETH; ordem pede 1 WETH → surplus 0.01 WETH (~$30)
    const e = await evaluateFill(order(), {
      ...base,
      quote: async () => 1_010_000_000_000_000_000n,
    });
    expect(e.ok).toBe(true);
    expect(e.profitToken?.toLowerCase()).toBe(WETH.toLowerCase());
    expect(e.profitWei).toBe(10_000_000_000_000_000n); // 0.01 WETH
    expect(e.minProfitWei).toBe(7_000_000_000_000_000n); // 70%
    expect(e.profitUsd).toBeCloseTo(30 - 0.05, 1);
  });

  it('rejeita quando o sourcing NÃO cobre a saída (sem surplus)', async () => {
    const e = await evaluateFill(order(), { ...base, quote: async () => 990_000_000_000_000_000n });
    expect(e.ok).toBe(false);
    expect(e.reason).toContain('surplus');
  });

  it('rejeita ordem expirada', async () => {
    const e = await evaluateFill(order({ deadline: 999 }), { ...base, quote: async () => 2n * 10n ** 18n });
    expect(e.ok).toBe(false);
    expect(e.reason).toContain('expirada');
  });

  it('rejeita quando sem rota de cotação', async () => {
    const e = await evaluateFill(order(), { ...base, quote: async () => null });
    expect(e.ok).toBe(false);
    expect(e.reason).toContain('sem rota');
  });

  it('rejeita lucro < threshold', async () => {
    // surplus minúsculo (~$0.30) < min $1
    const e = await evaluateFill(order(), { ...base, quote: async () => 1_000_100_000_000_000_000n });
    expect(e.ok).toBe(false);
    expect(e.reason).toContain('<');
  });

  it('rejeita saída long-tail sem preço USD (v1)', async () => {
    const e = await evaluateFill(order({ outputs: [{ token: VVV, amount: 100n, recipient: SWAPPER }] }), {
      ...base,
      quote: async () => 1000n,
    });
    expect(e.ok).toBe(false);
    expect(e.reason).toContain('sem preço');
  });

  it('rejeita múltiplos tokens de saída (v1 single-output)', async () => {
    const e = await evaluateFill(
      order({
        outputs: [
          { token: WETH, amount: 1n, recipient: SWAPPER },
          { token: USDC, amount: 1n, recipient: SWAPPER },
        ],
      }),
      { ...base, quote: async () => 2n * 10n ** 18n },
    );
    expect(e.ok).toBe(false);
    expect(e.reason).toContain('single-output');
  });
});

describe('buildFillTx — encode do executeFill', () => {
  const quote = {
    dex: DexType.UniswapV3,
    extraData: '0x0001f4' as const,
    router: '0x2626664c2603336E57B271c5C0b26F421741e481' as Address,
    poolOrRouter: '0x2626664c2603336E57B271c5C0b26F421741e481' as Address,
  } as never;

  it('encoda swap amountIn=0 + minAmountOut=requiredOut + params corretos', async () => {
    const evaluation = {
      ok: true as const,
      profitToken: WETH,
      requiredOut: 1_000_000_000_000_000_000n,
      expectedSwapOut: 1_010_000_000_000_000_000n,
      profitWei: 10_000_000_000_000_000n,
      minProfitWei: 7_000_000_000_000_000n,
    };
    const built = buildFillTx(order(), { fillerAddress: FILLER, profitReceiver: RECEIVER, quote, evaluation });
    expect(built.to).toBe(FILLER);

    const decoded = decodeFunctionData({ abi: ZEUS_UNISWAPX_FILLER_ABI, data: built.data });
    expect(decoded.functionName).toBe('executeFill');
    const p = (decoded.args as readonly any[])[0];
    expect(p.reactor).toBe(UNISWAPX_REACTORS_BASE.v2DutchOrder);
    expect(p.profitToken).toBe(WETH);
    expect(p.profitReceiver).toBe(RECEIVER);
    expect(p.minProfitWei).toBe(7_000_000_000_000_000n);
    expect(p.swapSteps.length).toBe(1);
    expect(p.swapSteps[0].amountIn).toBe(0n);
    expect(p.swapSteps[0].minAmountOut).toBe(1_000_000_000_000_000_000n); // = requiredOut
    expect(p.swapSteps[0].tokenIn).toBe(USDC);
    expect(p.swapSteps[0].tokenOut).toBe(WETH);
    expect(p.order.order).toBe('0xdead');
    expect(p.order.sig).toBe('0xbeef');
  });
});

describe('fetchOpenOrders — feed (mapeamento + fail-safe)', () => {
  const mockFetch = (impl: () => Promise<Partial<Response>>): typeof fetch =>
    impl as unknown as typeof fetch;

  // Shape REAL da API (validado ao vivo 2026-06-26): type→reactor, startAmount, cosignerData.outputOverrides.
  it('mapeia ordem da API real (type→reactor + outputOverride resolvido)', async () => {
    const fetchImpl = mockFetch(async () => ({
      ok: true,
      json: async () => ({
        orders: [
          {
            type: 'Dutch_V3',
            orderStatus: 'open',
            encodedOrder: '0xdead',
            signature: '0xbeef',
            orderHash: '0xhash',
            swapper: SWAPPER,
            input: { token: USDC, startAmount: '3000000000', maxAmount: '3000000000' },
            outputs: [{ token: WETH, startAmount: '1010000000000000000', minAmount: '1000000000000000000', recipient: SWAPPER }],
            cosignerData: { exclusiveFiller: '0x0000000000000000000000000000000000000000', outputOverrides: ['1005000000000000000'] },
          },
        ],
      }),
    }));
    const orders = await fetchOpenOrders({ chainId: 8453, fetchImpl });
    expect(orders.length).toBe(1);
    expect(orders[0]!.reactor).toBe(UNISWAPX_REACTORS_BASE.v3DutchOrder); // type Dutch_V3 → V3 reactor
    expect(orders[0]!.input.amount).toBe(3_000_000_000n); // startAmount
    expect(orders[0]!.outputs[0]!.amount).toBe(1_005_000_000_000_000_000n); // outputOverride (resolvido) > startAmount
    expect(orders[0]!.deadline).toBe(0); // sem deadline na API → 0 (confia no filtro open)
    expect(orders[0]!.exclusiveFiller).toBeUndefined(); // zero address → não exclusivo
  });

  it('extrai exclusiveFiller quando setado', async () => {
    const fetchImpl = mockFetch(async () => ({
      ok: true,
      json: async () => ({
        orders: [
          {
            type: 'Dutch_V2',
            encodedOrder: '0xdead',
            signature: '0xbeef',
            orderHash: '0xhash',
            input: { token: USDC, startAmount: '1000000' },
            outputs: [{ token: WETH, startAmount: '1', recipient: SWAPPER }],
            cosignerData: { exclusiveFiller: '0xB2D35561eCC160B71357E1822E83567486f3439a' },
          },
        ],
      }),
    }));
    const orders = await fetchOpenOrders({ chainId: 8453, fetchImpl });
    expect(orders[0]!.reactor).toBe(UNISWAPX_REACTORS_BASE.v2DutchOrder);
    expect(orders[0]!.exclusiveFiller?.toLowerCase()).toBe('0xb2d35561ecc160b71357e1822e83567486f3439a');
  });

  it('fail-safe: HTTP erro / json ruim / sem orders → []', async () => {
    expect(await fetchOpenOrders({ chainId: 8453, fetchImpl: mockFetch(async () => ({ ok: false })) })).toEqual([]);
    expect(
      await fetchOpenOrders({ chainId: 8453, fetchImpl: mockFetch(async () => ({ ok: true, json: async () => ({}) })) }),
    ).toEqual([]);
    expect(
      await fetchOpenOrders({
        chainId: 8453,
        fetchImpl: mockFetch(async () => {
          throw new Error('net');
        }),
      }),
    ).toEqual([]);
  });

  it('descarta ordem incompleta (sem assinatura/reactor)', async () => {
    const fetchImpl = mockFetch(async () => ({
      ok: true,
      json: async () => ({ orders: [{ orderHash: '0x1', input: { token: USDC, amount: '1' } }] }),
    }));
    expect(await fetchOpenOrders({ chainId: 8453, fetchImpl })).toEqual([]);
  });
});
