/**
 * Fork test dos QUOTERS off-chain do Motor 2 contra Base mainnet (pools REAIS).
 *
 * Gap fechado: `readUniV3PoolState` já tinha fork test (liquidator/pricingLocal.fork),
 * mas os quoters que o mis-scanner usa pra cotar swaps — quoteUniswapV3, quoteSlipstream,
 * quoteUniswapV2 — e o `readAeroPoolState` NÃO eram exercitados contra a chain.
 *
 * O que ESTE teste prova: a ABI de cada quoter bate com os contratos reais na Base
 * (quote de 1 par conhecido WETH/USDC retorna amountOut numérico > 0, na faixa sã de
 * milhares de USDC por WETH). NÃO prova lucro, nem que a execução on-chain casa — só
 * que a leitura off-chain funciona contra a realidade.
 *
 * SKIP automático se BASE_RPC_HTTP não definido (padrão describe.skip). Sem block
 * pinado (estado atual da chain); asserts em ranges amplos (preço varia por bloco).
 *
 * Rodar (do repo root):
 *   set -a; . ./.env; set +a
 *   pnpm --filter @zeus-evm/mis-scanner exec vitest run dexQuotes.fork
 */

import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address } from 'viem';
import { base } from 'viem/chains';
import { BASE_MAINNET } from '@zeus-evm/chain-config';
import {
  quoteUniswapV3,
  quoteSlipstream,
  quoteUniswapV2,
  readAeroPoolState,
  getAeroPoolAddress,
  getSlipstreamPoolAddress,
  isQuote,
} from '@zeus-evm/dex-adapters';

const rpcUrl = process.env.BASE_RPC_HTTP;
const SKIP = rpcUrl ? describe : describe.skip;

const client = rpcUrl ? createPublicClient({ chain: base, transport: http(rpcUrl) }) : null;

const WETH = BASE_MAINNET.tokens.WETH as Address;
const USDC = BASE_MAINNET.tokens.USDC as Address;

const ONE_WETH = 10n ** 18n;
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// Faixa de sanidade: 1 WETH ~ alguns milhares de USDC. Margem ampla (preço varia por bloco).
const MIN_USDC_OUT = 500n * 10n ** 6n; // 500 USDC
const MAX_USDC_OUT = 100_000n * 10n ** 6n; // 100k USDC

const UNIV3_QUOTER_V2 = BASE_MAINNET.uniswapV3.quoterV2 as Address;
const UNIV3_WETH_USDC_FEE = 500; // 0.05% — par WETH/USDC mais líquido na Base

const SLIPSTREAM_QUOTER = BASE_MAINNET.slipstream.quoter as Address;
const SLIPSTREAM_SWAP_ROUTER = BASE_MAINNET.slipstream.swapRouter as Address;
const SLIPSTREAM_FACTORY = BASE_MAINNET.slipstream.factory as Address;
// tickSpacings candidatos pro par WETH/USDC (volatile). Descobrimos o vivo no setup.
const SLIPSTREAM_TICK_SPACINGS = BASE_MAINNET.slipstream.tickSpacings;

const BASESWAP_ROUTER = BASE_MAINNET.baseswap.router as Address;

const AERO_FACTORY = BASE_MAINNET.aerodrome.factory as Address;

SKIP('DEX quoters off-chain — Base mainnet fork (WETH/USDC)', () => {
  it('quoteUniswapV3 (WETH→USDC, fee 500) retorna amountOut > 0 na faixa sã', async () => {
    const q = await quoteUniswapV3({
      client: client!,
      quoterAddress: UNIV3_QUOTER_V2,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: ONE_WETH,
      fee: UNIV3_WETH_USDC_FEE,
      decimalsIn: WETH_DECIMALS,
      decimalsOut: USDC_DECIMALS,
    });

    // QuoteResult: sucesso (Quote) traz `amountOut`; falha (QuoteError) traz `reason`.
    if (!isQuote(q)) {
      throw new Error(`quoteUniswapV3 falhou: ${q.reason}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[UniV3] 1 WETH → ${Number(q.amountOut) / 1e6} USDC (effPrice=${q.effectivePrice})`);
    expect(q.amountOut).toBeGreaterThan(MIN_USDC_OUT);
    expect(q.amountOut).toBeLessThan(MAX_USDC_OUT);
  }, 30_000);

  it('quoteSlipstream (WETH→USDC, tickSpacing vivo) retorna amountOut > 0 na faixa sã', async () => {
    // Descobre o primeiro tickSpacing que tem pool WETH/USDC na Slipstream CL.
    let liveTickSpacing: number | null = null;
    for (const ts of SLIPSTREAM_TICK_SPACINGS) {
      const pool = await getSlipstreamPoolAddress({
        client: client!,
        factory: SLIPSTREAM_FACTORY,
        tokenA: WETH,
        tokenB: USDC,
        tickSpacing: ts,
      });
      if (pool) {
        liveTickSpacing = ts;
        break;
      }
    }
    expect(liveTickSpacing, 'nenhum pool Slipstream WETH/USDC encontrado').not.toBeNull();

    const q = await quoteSlipstream({
      client: client!,
      quoterAddress: SLIPSTREAM_QUOTER,
      swapRouter: SLIPSTREAM_SWAP_ROUTER,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: ONE_WETH,
      tickSpacing: liveTickSpacing!,
      decimalsIn: WETH_DECIMALS,
      decimalsOut: USDC_DECIMALS,
    });

    if (!isQuote(q)) {
      throw new Error(`quoteSlipstream falhou: ${q.reason}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[Slipstream ts=${liveTickSpacing}] 1 WETH → ${Number(q.amountOut) / 1e6} USDC`);
    expect(q.amountOut).toBeGreaterThan(MIN_USDC_OUT);
    expect(q.amountOut).toBeLessThan(MAX_USDC_OUT);
  }, 45_000);

  it('quoteUniswapV2 (WETH→USDC via BaseSwap) retorna amountOut > 0 na faixa sã', async () => {
    const q = await quoteUniswapV2({
      client: client!,
      routerAddress: BASESWAP_ROUTER,
      venue: 'baseswap',
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: ONE_WETH,
      decimalsIn: WETH_DECIMALS,
      decimalsOut: USDC_DECIMALS,
    });

    if (!isQuote(q)) {
      throw new Error(`quoteUniswapV2 falhou: ${q.reason}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[UniV2/BaseSwap] 1 WETH → ${Number(q.amountOut) / 1e6} USDC`);
    expect(q.amountOut).toBeGreaterThan(MIN_USDC_OUT);
    expect(q.amountOut).toBeLessThan(MAX_USDC_OUT);
  }, 30_000);

  it('readAeroPoolState de um pool Aerodrome WETH/USDC real retorna reserves > 0', async () => {
    // Aerodrome: par volátil (stable=false) é o que tem WETH/USDC. Tenta volatile, depois stable.
    let pool = await getAeroPoolAddress({
      client: client!,
      factory: AERO_FACTORY,
      tokenA: WETH,
      tokenB: USDC,
      stable: false,
    });
    if (!pool) {
      pool = await getAeroPoolAddress({
        client: client!,
        factory: AERO_FACTORY,
        tokenA: WETH,
        tokenB: USDC,
        stable: true,
      });
    }
    expect(pool, 'nenhum pool Aerodrome WETH/USDC encontrado').not.toBeNull();

    const state = await readAeroPoolState({ client: client!, pool: pool! });
    expect(state).not.toBeNull();
    // eslint-disable-next-line no-console
    console.log(
      `[Aerodrome ${pool}] stable=${state!.stable} reserve0=${state!.reserve0} reserve1=${state!.reserve1}`,
    );
    expect(state!.reserve0).toBeGreaterThan(0n);
    expect(state!.reserve1).toBeGreaterThan(0n);

    // Sanidade adicional: o lado USDC deve representar milhares de dólares de liquidez.
    const usdcIsToken0 = state!.token0.toLowerCase() === USDC.toLowerCase();
    const usdcReserve = usdcIsToken0 ? state!.reserve0 : state!.reserve1;
    expect(usdcReserve).toBeGreaterThan(1_000n * 10n ** 6n); // > 1k USDC de liquidez
  }, 30_000);
});
