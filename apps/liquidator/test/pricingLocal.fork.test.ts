/**
 * Fork test do pricing local contra pools REAIS de Base mainnet.
 *
 * Valida que o spot price calculado off-chain (sqrtPriceX96/reserves) bate com a
 * realidade — confirma a math antes de construir o MIS em cima.
 *
 * SKIP automático se BASE_RPC_HTTP não definido. Sem block pinado (estado atual).
 * Asserts em ranges amplos (preço varia por bloco — não cravamos valor exato).
 */

import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address } from 'viem';
import { base } from 'viem/chains';
import { BASE_MAINNET } from '@zeus-evm/chain-config';
import {
  getUniV3PoolAddress,
  readUniV3PoolState,
  uniV3StateToSpot,
  uniV3SpotPriceInverse1e18,
} from '@zeus-evm/dex-adapters';

const rpcUrl = process.env.BASE_RPC_HTTP;
const SKIP = rpcUrl ? describe : describe.skip;

const client = rpcUrl ? createPublicClient({ chain: base, transport: http(rpcUrl) }) : null;

const WETH = BASE_MAINNET.tokens.WETH as Address;
const USDC = BASE_MAINNET.tokens.USDC as Address;
const WAD = 10n ** 18n;

SKIP('Pricing local — Base mainnet fork (WETH/USDC UniV3)', () => {
  it('spot price do pool WETH/USDC 0.05% bate com faixa de mercado real', async () => {
    const pool = await getUniV3PoolAddress({
      client: client!,
      factory: BASE_MAINNET.uniswapV3.factory as Address,
      tokenA: WETH,
      tokenB: USDC,
      fee: 500,
    });
    expect(pool).not.toBeNull();

    const state = await readUniV3PoolState({ client: client!, pool: pool! });
    expect(state).not.toBeNull();

    // token0/token1 dependem da ordenação de endereço. Descobrir quem é WETH.
    const wethIsToken0 = state!.token0.toLowerCase() === WETH.toLowerCase();
    const dec0 = wethIsToken0 ? 18 : 6; // WETH 18 / USDC 6
    const dec1 = wethIsToken0 ? 6 : 18;

    const spot = uniV3StateToSpot(state!, dec0, dec1); // token1 por token0

    // Preço de 1 WETH em USDC deve estar numa faixa ampla mas sã (US$ 1000-10000)
    let wethInUsdc: bigint;
    if (wethIsToken0) {
      // spot = USDC por WETH (token1/token0) já é o que queremos
      wethInUsdc = spot;
    } else {
      // spot = WETH por USDC → inverter
      wethInUsdc = uniV3SpotPriceInverse1e18(state!.sqrtPriceX96, dec0, dec1);
    }

    const wethUsdcHuman = Number(wethInUsdc / WAD);
    expect(wethUsdcHuman).toBeGreaterThan(1000);
    expect(wethUsdcHuman).toBeLessThan(10000);
  }, 30_000);

  it('sqrtPriceX96 lido é > 0 (pool ativo)', async () => {
    const pool = await getUniV3PoolAddress({
      client: client!,
      factory: BASE_MAINNET.uniswapV3.factory as Address,
      tokenA: WETH,
      tokenB: USDC,
      fee: 500,
    });
    const state = await readUniV3PoolState({ client: client!, pool: pool! });
    expect(state!.sqrtPriceX96).toBeGreaterThan(0n);
    expect(state!.liquidity).toBeGreaterThan(0n);
  }, 30_000);
});
