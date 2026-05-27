/**
 * Fork tests do AavePriceOracle + math utils (oracle.ts) contra Base mainnet.
 *
 * Valida que os fixes B-1, B-2, B-3 do audit 2026-05-26 funcionam contra dados
 * reais do oracle Aave V3 em Base. Antes do fix, calculator assumia stable-peg
 * em todo cálculo USD — quebrava em qualquer par WETH/WBTC.
 *
 * Filosofia:
 *  - Pin block fixo pra reprodutibilidade
 *  - SKIP automático se BASE_RPC_HTTP não definido
 *  - Não usa mocks — testa contra oracle real
 *  - Asserts em ranges razoáveis (preços variam por bloco)
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { BASE_MAINNET } from '@zeus-evm/chain-config';

import {
  AavePriceOracle,
  AAVE_BASE_CURRENCY_UNIT,
  convertWeiByPrice,
  usdToWei,
  weiToUsd,
} from '../src/protocols/aave/oracle';

const rpcUrl = process.env.BASE_RPC_HTTP;
const SKIP_IF_NO_RPC = rpcUrl ? describe : describe.skip;

const PINNED_BLOCK = 28_000_000n;

const client = rpcUrl
  ? createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    })
  : null;

SKIP_IF_NO_RPC('AavePriceOracle — Base mainnet fork', () => {
  let oracle: AavePriceOracle;

  beforeAll(() => {
    if (!client) throw new Error('client not initialized');
    oracle = new AavePriceOracle(client, BASE_MAINNET.aave.oracle);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Oracle reads — preços reais
  // ═══════════════════════════════════════════════════════════════════════

  it('lê preço de WETH em USD (8 decimals)', async () => {
    const price = await oracle.getAssetPrice(BASE_MAINNET.tokens.WETH, PINNED_BLOCK);

    // ETH em ~$3000-5000 range é razoável historicamente
    // Oracle retorna em 8 decimais: 350000000000 = $3500.00
    const priceUsd = Number(price) / Number(AAVE_BASE_CURRENCY_UNIT);
    expect(priceUsd).toBeGreaterThan(1000); // sanidade extrema
    expect(priceUsd).toBeLessThan(10000); // sanidade extrema
  });

  it('lê preço de USDC ≈ $1', async () => {
    const price = await oracle.getAssetPrice(BASE_MAINNET.tokens.USDC, PINNED_BLOCK);
    const priceUsd = Number(price) / Number(AAVE_BASE_CURRENCY_UNIT);
    // USDC peg: $0.97-$1.03 banda generosa
    expect(priceUsd).toBeGreaterThan(0.97);
    expect(priceUsd).toBeLessThan(1.03);
  });

  it('lê preço de cbETH em USD próximo do WETH (LST)', async () => {
    const [wethPrice, cbethPrice] = await Promise.all([
      oracle.getAssetPrice(BASE_MAINNET.tokens.WETH, PINNED_BLOCK),
      oracle.getAssetPrice(BASE_MAINNET.tokens.cbETH, PINNED_BLOCK),
    ]);

    // cbETH é LST de ETH com pequeno premium ou desconto (geralmente ±5%)
    const ratio = Number(cbethPrice) / Number(wethPrice);
    expect(ratio).toBeGreaterThan(0.90);
    expect(ratio).toBeLessThan(1.15);
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Batched fetch — getAssetsPrices
  // ═══════════════════════════════════════════════════════════════════════

  it('getAssetsPrices retorna mapa com múltiplos preços via 1 RPC call', async () => {
    const prices = await oracle.getAssetsPrices(
      [BASE_MAINNET.tokens.WETH, BASE_MAINNET.tokens.USDC, BASE_MAINNET.tokens.cbETH],
      PINNED_BLOCK,
    );

    expect(prices.size).toBe(3);
    expect(prices.get(BASE_MAINNET.tokens.WETH.toLowerCase())).toBeDefined();
    expect(prices.get(BASE_MAINNET.tokens.USDC.toLowerCase())).toBeDefined();
    expect(prices.get(BASE_MAINNET.tokens.cbETH.toLowerCase())).toBeDefined();
  });

  it('cache by-block: 2ª chamada mesmo bloco não bate RPC', async () => {
    // Primeira chamada: bate RPC
    const t1 = performance.now();
    await oracle.getAssetPrice(BASE_MAINNET.tokens.WETH, PINNED_BLOCK);
    const t1Elapsed = performance.now() - t1;

    // Segunda chamada (mesmo bloco): deve vir do cache
    const t2 = performance.now();
    await oracle.getAssetPrice(BASE_MAINNET.tokens.WETH, PINNED_BLOCK);
    const t2Elapsed = performance.now() - t2;

    // Cache deve ser ordens de magnitude mais rápido
    expect(t2Elapsed).toBeLessThan(t1Elapsed / 2);
  });
});

SKIP_IF_NO_RPC('Math utils — oracle-based conversions (B-1, B-2, B-3 fix)', () => {
  let oracle: AavePriceOracle;
  let wethPrice: bigint;
  let usdcPrice: bigint;

  beforeAll(async () => {
    if (!client) throw new Error('client not initialized');
    oracle = new AavePriceOracle(client, BASE_MAINNET.aave.oracle);
    const prices = await oracle.getAssetsPrices(
      [BASE_MAINNET.tokens.WETH, BASE_MAINNET.tokens.USDC],
      PINNED_BLOCK,
    );
    wethPrice = prices.get(BASE_MAINNET.tokens.WETH.toLowerCase())!;
    usdcPrice = prices.get(BASE_MAINNET.tokens.USDC.toLowerCase())!;
  });

  // ─── B-1 fix: weiToUsd ─────────────────────────────────────────────

  it('B-1: weiToUsd(1 ETH em WETH wei) ≈ preço WETH ($1000-10000)', () => {
    const oneEth = 10n ** 18n;
    const usd = weiToUsd(oneEth, wethPrice, 18);
    expect(usd).toBeGreaterThan(1000);
    expect(usd).toBeLessThan(10000);
  });

  it('B-1: weiToUsd(1000 USDC em USDC wei) ≈ $1000', () => {
    const thousandUsdc = 1000n * 10n ** 6n;
    const usd = weiToUsd(thousandUsdc, usdcPrice, 6);
    expect(usd).toBeGreaterThan(970);
    expect(usd).toBeLessThan(1030);
  });

  it('B-1: weiToUsd(0) = 0', () => {
    expect(weiToUsd(0n, wethPrice, 18)).toBe(0);
  });

  // ─── B-3 fix: usdToWei ─────────────────────────────────────────────

  it('B-3: usdToWei($1000, WETH) ≈ wei equivalente', () => {
    const wei = usdToWei(1000, wethPrice, 18);
    // 1000 USD em WETH @ ~$3500 = ~0.286 ETH = ~286_000_000_000_000_000 wei
    expect(wei).toBeGreaterThan(10n ** 17n);  // > 0.1 ETH
    expect(wei).toBeLessThan(10n ** 18n);     // < 1 ETH
  });

  it('B-3: usdToWei($1000, USDC) ≈ 1000e6 wei', () => {
    const wei = usdToWei(1000, usdcPrice, 6);
    expect(wei).toBeGreaterThan(970n * 10n ** 6n);
    expect(wei).toBeLessThan(1030n * 10n ** 6n);
  });

  it('B-3: usdToWei(0) = 0', () => {
    expect(usdToWei(0, wethPrice, 18)).toBe(0n);
  });

  // ─── Round-trip USD → wei → USD ────────────────────────────────────

  it('round-trip $500 → WETH wei → USD: <0.1% drift', () => {
    const original = 500;
    const asWei = usdToWei(original, wethPrice, 18);
    const backToUsd = weiToUsd(asWei, wethPrice, 18);
    const driftPct = Math.abs(backToUsd - original) / original;
    expect(driftPct).toBeLessThan(0.001); // < 0.1%
  });

  it('round-trip $500 → USDC wei → USD: <0.5% drift', () => {
    // USDC tem 6 decimais, drift maior por arredondamento
    const original = 500;
    const asWei = usdToWei(original, usdcPrice, 6);
    const backToUsd = weiToUsd(asWei, usdcPrice, 6);
    const driftPct = Math.abs(backToUsd - original) / original;
    expect(driftPct).toBeLessThan(0.005); // < 0.5%
  });

  // ─── B-2 fix: convertWeiByPrice ───────────────────────────────────

  it('B-2: convertWeiByPrice(1 WETH → USDC) ≈ preço WETH em USDC', () => {
    const oneEth = 10n ** 18n;
    const usdcEquivalent = convertWeiByPrice(
      oneEth,
      wethPrice, 18,
      usdcPrice, 6,
    );

    // 1 ETH em USDC @ ~$3500 = ~3500e6 USDC wei
    expect(usdcEquivalent).toBeGreaterThan(1_000n * 10n ** 6n);  // > $1000
    expect(usdcEquivalent).toBeLessThan(10_000n * 10n ** 6n);   // < $10k

    // Cross-check com weiToUsd: deve bater
    const ethUsd = weiToUsd(oneEth, wethPrice, 18);
    const usdcAsUsd = weiToUsd(usdcEquivalent, usdcPrice, 6);
    const driftPct = Math.abs(ethUsd - usdcAsUsd) / ethUsd;
    expect(driftPct).toBeLessThan(0.001); // < 0.1% drift cross-conversion
  });

  it('B-2: convertWeiByPrice(1000 USDC → WETH) reverso bate', () => {
    const thousandUsdc = 1000n * 10n ** 6n;
    const wethEquivalent = convertWeiByPrice(
      thousandUsdc,
      usdcPrice, 6,
      wethPrice, 18,
    );

    // $1000 em WETH @ ~$3500 = ~0.286 ETH
    expect(wethEquivalent).toBeGreaterThan(10n ** 17n);
    expect(wethEquivalent).toBeLessThan(10n ** 18n);

    // Round-trip
    const backToUsdc = convertWeiByPrice(
      wethEquivalent,
      wethPrice, 18,
      usdcPrice, 6,
    );
    const drift = backToUsdc > thousandUsdc
      ? Number(backToUsdc - thousandUsdc)
      : Number(thousandUsdc - backToUsdc);
    expect(drift).toBeLessThan(Number(thousandUsdc) * 0.005); // < 0.5% drift
  });

  it('B-2 stress: convertWeiByPrice WBTC→USDC com decimais diferentes (8→6)', async () => {
    // WBTC tem 8 decimais. Aave Base oracle suporta WBTC se reserva existe.
    // Como Base não tem WBTC nativo no Aave V3, usamos cbBTC se possível ou skip
    // se preço retornar zero. Esse é teste defensivo do path B-2 mais brutal.

    // Em Base mainnet, cbBTC e WBTC podem não estar no Aave oracle (depende reserva).
    // Pulamos esse teste se preço não está disponível — não bloqueia validação dos outros.
    const cbBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' as const;
    let cbBTCPrice: bigint;
    try {
      cbBTCPrice = await oracle.getAssetPrice(cbBTC, PINNED_BLOCK);
    } catch {
      return; // skip se não disponível
    }
    if (cbBTCPrice === 0n) return;

    // 0.01 cbBTC (10^6 = 0.01 * 10^8) em USDC
    const cbBTCAmount = 10n ** 6n;
    const usdcEquivalent = convertWeiByPrice(
      cbBTCAmount,
      cbBTCPrice, 8,
      usdcPrice, 6,
    );

    // 0.01 BTC @ ~$60k = ~$600 = 600e6 USDC
    expect(usdcEquivalent).toBeGreaterThan(100n * 10n ** 6n);   // > $100
    expect(usdcEquivalent).toBeLessThan(2_000n * 10n ** 6n);    // < $2000
  });

  // ─── Edge cases ────────────────────────────────────────────────────

  it('weiToUsd com price 0 retorna 0 (não NaN, não Infinity)', () => {
    expect(weiToUsd(10n ** 18n, 0n, 18)).toBe(0);
  });

  it('usdToWei com price 0 retorna 0', () => {
    expect(usdToWei(1000, 0n, 18)).toBe(0n);
  });

  it('convertWeiByPrice com priceB=0 retorna 0', () => {
    expect(convertWeiByPrice(10n ** 18n, wethPrice, 18, 0n, 6)).toBe(0n);
  });
});
