/**
 * Fork test do Trader Joe LB contra Avalanche REAL — GATE DE VALIDAÇÃO.
 *
 * Skipado sem AVALANCHE_RPC_HTTP. Quando o RPC (pago) estiver no .env, este teste
 * confirma que o spot derivado do getSwapOut tem orientação/decimais corretos —
 * a única peça do adapter TJ que não dá pra validar só com mock (meu limite de
 * conhecimento no AMM por bins). Roda:
 *   pnpm --filter @zeus-evm/mis-scanner test -- traderJoe.fork
 */

import { describe, expect, it } from 'vitest';
import { createPublicClient, http, formatUnits, parseUnits, type Address } from 'viem';
import { avalanche } from 'viem/chains';

import { AVALANCHE_MAINNET } from '@zeus-evm/chain-config';
import { getTraderJoePairs, readLBPairState, quoteTraderJoe, lbSwapOutToSpot1e18 } from '@zeus-evm/dex-adapters';

const RPC = process.env.AVALANCHE_RPC_HTTP;

describe.skipIf(!RPC)('Trader Joe LB — fork Avalanche (validação de orientação/preço)', () => {
  it('spot WAVAX/USDC via getSwapOut cai numa faixa sã (preço do AVAX em USD)', async () => {
    const client = createPublicClient({ chain: avalanche, transport: http(RPC) });
    const WAVAX = AVALANCHE_MAINNET.tokens['WAVAX'] as Address;
    const USDC = AVALANCHE_MAINNET.tokens['USDC'] as Address;
    const factory = AVALANCHE_MAINNET.traderJoe!.lbFactory;

    const pairs = await getTraderJoePairs({ client, factory, tokenA: WAVAX, tokenB: USDC });
    expect(pairs.length).toBeGreaterThan(0); // tem pelo menos 1 LB pair WAVAX/USDC

    // Pega o primeiro pair com liquidez e cota 1 WAVAX → USDC
    let spotUsd = 0;
    for (const p of pairs) {
      const state = await readLBPairState({ client, pair: p.pair });
      if (!state || (state.reserveX === 0n && state.reserveY === 0n)) continue;
      const swapForY = state.tokenX.toLowerCase() === WAVAX.toLowerCase();
      const q = await quoteTraderJoe({ client, pair: p.pair, amountIn: parseUnits('1', 18), swapForY });
      if (!q || q.amountOut === 0n) continue;
      const spot = lbSwapOutToSpot1e18({
        amountIn: parseUnits('1', 18),
        amountInLeft: q.amountInLeft,
        amountOut: q.amountOut,
        fee: q.fee,
        decimalsIn: 18,
        decimalsOut: 6,
      });
      spotUsd = Number(formatUnits(spot, 18)); // USDC por WAVAX
      break;
    }

    // AVAX historicamente entre ~$5 e ~$200 — faixa sã pra pegar erro de orientação/decimais
    expect(spotUsd).toBeGreaterThan(3);
    expect(spotUsd).toBeLessThan(500);
  });
});
