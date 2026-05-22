/**
 * Tests validando o pricing engine contra Base mainnet via Alchemy.
 *
 * Filosofia:
 *  - Não usar mocks pra DEX (perderia o valor de validação)
 *  - Usar pin ao bloco fixo (`pinnedBlock`) pra reprodutibilidade
 *  - Validar invariantes: amountOut > 0, preço dentro de range razoável
 *
 * SKIP automático se BASE_RPC_HTTP não definido (CI sem secrets).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

import { BASE_MAINNET, BASE_TARGET_PAIRS } from '@zeus-evm/chain-config';
import { isQuote, quoteUniswapV3, quoteAerodrome } from '../src';

const rpcUrl = process.env.BASE_RPC_HTTP;
const SKIP_IF_NO_RPC = rpcUrl ? describe : describe.skip;

// Bloco fixo recente pra reprodutibilidade (atualizar manualmente se necessário)
const PINNED_BLOCK = 46_330_000n;

const client = rpcUrl
  ? createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    })
  : null;

SKIP_IF_NO_RPC('UniswapV3 Quoter — Base mainnet', () => {
  beforeAll(() => {
    if (!client) throw new Error('client not initialized');
  });

  it('quotes 1 WETH -> USDC (fee 500) com preço razoavel', async () => {
    const result = await quoteUniswapV3({
      client: client!,
      quoterAddress: BASE_MAINNET.uniswapV3.quoterV2,
      tokenIn: BASE_MAINNET.tokens.WETH,
      tokenOut: BASE_MAINNET.tokens.USDC,
      amountIn: 1_000_000_000_000_000_000n, // 1 WETH
      fee: 500,
      decimalsIn: 18,
      decimalsOut: 6,
      blockNumber: PINNED_BLOCK,
    });

    expect(isQuote(result)).toBe(true);
    if (!isQuote(result)) return;

    // ETH price entre $1k e $10k é razoável (range largo pra absorver volatilidade)
    expect(result.effectivePrice).toBeGreaterThan(1000);
    expect(result.effectivePrice).toBeLessThan(10000);
    expect(result.amountOut).toBeGreaterThan(0n);
    console.log(`  -> 1 WETH = ${result.effectivePrice.toFixed(2)} USDC (fee 0.05%)`);
  });

  it('quotes 1 WETH -> USDC com 3 fee tiers diferentes', async () => {
    const fees = [500, 3000, 10000];
    const results = await Promise.all(
      fees.map((fee) =>
        quoteUniswapV3({
          client: client!,
          quoterAddress: BASE_MAINNET.uniswapV3.quoterV2,
          tokenIn: BASE_MAINNET.tokens.WETH,
          tokenOut: BASE_MAINNET.tokens.USDC,
          amountIn: 1_000_000_000_000_000_000n,
          fee,
          decimalsIn: 18,
          decimalsOut: 6,
          blockNumber: PINNED_BLOCK,
        }),
      ),
    );

    // Pelo menos 1 deve funcionar (fee 500 sempre tem liquidez forte em WETH/USDC)
    const valid = results.filter(isQuote);
    expect(valid.length).toBeGreaterThanOrEqual(1);

    valid.forEach((q) => {
      console.log(`  -> ${q.source}: ${q.effectivePrice.toFixed(4)} USDC/WETH`);
    });
  });

  it('retorna erro estruturado pra pool inexistente (fee invalido)', async () => {
    const result = await quoteUniswapV3({
      client: client!,
      quoterAddress: BASE_MAINNET.uniswapV3.quoterV2,
      tokenIn: BASE_MAINNET.tokens.WETH,
      tokenOut: BASE_MAINNET.tokens.USDC,
      amountIn: 1_000_000_000_000_000_000n,
      fee: 7777, // fee tier inexistente
      decimalsIn: 18,
      decimalsOut: 6,
      blockNumber: PINNED_BLOCK,
    });

    expect(isQuote(result)).toBe(false);
    if (!isQuote(result)) {
      expect(result.reason).toBeTruthy();
      console.log(`  -> erro esperado: ${result.reason.slice(0, 80)}`);
    }
  });
});

SKIP_IF_NO_RPC('Aerodrome Router — Base mainnet', () => {
  beforeAll(() => {
    if (!client) throw new Error('client not initialized');
  });

  it('quotes 1 WETH -> USDC volatile (Aerodrome)', async () => {
    if (!BASE_MAINNET.aerodrome) throw new Error('Aerodrome config missing');

    const result = await quoteAerodrome({
      client: client!,
      routerAddress: BASE_MAINNET.aerodrome.router,
      factoryAddress: BASE_MAINNET.aerodrome.factory,
      tokenIn: BASE_MAINNET.tokens.WETH,
      tokenOut: BASE_MAINNET.tokens.USDC,
      amountIn: 1_000_000_000_000_000_000n,
      stable: false,
      decimalsIn: 18,
      decimalsOut: 6,
      blockNumber: PINNED_BLOCK,
    });

    expect(isQuote(result)).toBe(true);
    if (!isQuote(result)) return;

    expect(result.effectivePrice).toBeGreaterThan(1000);
    expect(result.effectivePrice).toBeLessThan(10000);
    console.log(`  -> 1 WETH = ${result.effectivePrice.toFixed(2)} USDC (Aerodrome volatile)`);
  });

  it('quotes 1 USDC -> USDT stable (Aerodrome)', async () => {
    if (!BASE_MAINNET.aerodrome) throw new Error('Aerodrome config missing');

    const result = await quoteAerodrome({
      client: client!,
      routerAddress: BASE_MAINNET.aerodrome.router,
      factoryAddress: BASE_MAINNET.aerodrome.factory,
      tokenIn: BASE_MAINNET.tokens.USDC,
      tokenOut: BASE_MAINNET.tokens.USDT,
      amountIn: 1_000_000n, // 1 USDC
      stable: true,
      decimalsIn: 6,
      decimalsOut: 6,
      blockNumber: PINNED_BLOCK,
    });

    if (!isQuote(result)) {
      console.log(`  -> Aerodrome stable USDC/USDT erro: ${result.reason}`);
      // OK falhar se pool não existe — vamos só logar
      return;
    }

    // Stable swap: preço deve ser ~1.0 (peg perfeito ou close)
    expect(result.effectivePrice).toBeGreaterThan(0.95);
    expect(result.effectivePrice).toBeLessThan(1.05);
    console.log(`  -> 1 USDC = ${result.effectivePrice.toFixed(6)} USDT (Aerodrome stable)`);
  });
});

SKIP_IF_NO_RPC('Cross-DEX comparison — base sanity', () => {
  it('preço WETH/USDC entre UniV3 e Aerodrome deve estar próximo (< 2% gap)', async () => {
    if (!BASE_MAINNET.aerodrome) throw new Error('Aerodrome config missing');

    const [uniResult, aeroResult] = await Promise.all([
      quoteUniswapV3({
        client: client!,
        quoterAddress: BASE_MAINNET.uniswapV3.quoterV2,
        tokenIn: BASE_MAINNET.tokens.WETH,
        tokenOut: BASE_MAINNET.tokens.USDC,
        amountIn: 1_000_000_000_000_000_000n,
        fee: 500,
        decimalsIn: 18,
        decimalsOut: 6,
        blockNumber: PINNED_BLOCK,
      }),
      quoteAerodrome({
        client: client!,
        routerAddress: BASE_MAINNET.aerodrome.router,
        factoryAddress: BASE_MAINNET.aerodrome.factory,
        tokenIn: BASE_MAINNET.tokens.WETH,
        tokenOut: BASE_MAINNET.tokens.USDC,
        amountIn: 1_000_000_000_000_000_000n,
        stable: false,
        decimalsIn: 18,
        decimalsOut: 6,
        blockNumber: PINNED_BLOCK,
      }),
    ]);

    if (!isQuote(uniResult) || !isQuote(aeroResult)) {
      throw new Error('Esperava ambos os quotes — verificar config');
    }

    const gap = Math.abs(uniResult.effectivePrice - aeroResult.effectivePrice);
    const gapPct = (gap / uniResult.effectivePrice) * 100;

    console.log(`  -> UniV3:     ${uniResult.effectivePrice.toFixed(2)} USDC/WETH`);
    console.log(`  -> Aerodrome: ${aeroResult.effectivePrice.toFixed(2)} USDC/WETH`);
    console.log(`  -> Gap:       ${gap.toFixed(2)} USDC (${gapPct.toFixed(3)}%)`);

    // Sanity: pares líquidos não devem ter gap > 2% em condições normais
    expect(gapPct).toBeLessThan(2);
  });
});
