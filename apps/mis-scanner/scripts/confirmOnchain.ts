/**
 * Confirmação on-chain de ENDEREÇOS + ABIs + premium do FLASHLOAN — via eth_call puro
 * (funciona no RPC free; fork test exige tier pago). Reusa os adapters reais do projeto,
 * então provar que estas chamadas respondem = provar que nossas ABIs batem com a mainnet.
 *
 *   pnpm --filter @zeus-evm/mis-scanner exec tsx scripts/confirmOnchain.ts
 */
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { createPublicClient, http, formatUnits, parseUnits, type Address, type PublicClient } from 'viem';
import { base, polygon, avalanche } from 'viem/chains';

import { BASE_MAINNET, POLYGON_MAINNET, AVALANCHE_MAINNET, type ChainConfig } from '@zeus-evm/chain-config';
import {
  getUniV3PoolAddress,
  readUniV3PoolState,
  getTraderJoePairs,
  readLBPairState,
  quoteTraderJoe,
  lbSwapOutToSpot1e18,
} from '@zeus-evm/dex-adapters';

dotenv.config();
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env') });

const AAVE_ABI = [
  { type: 'function', name: 'getReservesList', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'FLASHLOAN_PREMIUM_TOTAL', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { type: 'function', name: 'ADDRESSES_PROVIDER', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

type Chain = { name: string; cfg: ChainConfig; viem: typeof base; rpc: string | undefined; uniPair: [string, string]; tjPair?: [string, string] };

const CHAINS: Chain[] = [
  { name: 'Base', cfg: BASE_MAINNET, viem: base, rpc: process.env.BASE_RPC_HTTP, uniPair: ['WETH', 'USDC'] },
  { name: 'Polygon', cfg: POLYGON_MAINNET, viem: polygon as unknown as typeof base, rpc: process.env.POLYGON_RPC_HTTP, uniPair: ['WETH', 'USDC'] },
  { name: 'Avalanche', cfg: AVALANCHE_MAINNET, viem: avalanche as unknown as typeof base, rpc: process.env.AVALANCHE_RPC_HTTP, uniPair: ['WETH.e', 'USDC'], tjPair: ['WAVAX', 'USDC'] },
];

async function confirmChain(c: Chain): Promise<void> {
  console.log(`\n========== ${c.name} (chainId ${c.cfg.chainId}) ==========`);
  if (!c.rpc) { console.log('  ⏭️  sem RPC no .env — pulado'); return; }
  const client = createPublicClient({ chain: c.viem, transport: http(c.rpc) }) as PublicClient;

  // 1) Aave V3 — endereço + ABI + premium do flashloan
  try {
    const reserves = (await client.readContract({ address: c.cfg.aave.pool, abi: AAVE_ABI, functionName: 'getReservesList' })) as readonly Address[];
    const premium = (await client.readContract({ address: c.cfg.aave.pool, abi: AAVE_ABI, functionName: 'FLASHLOAN_PREMIUM_TOTAL' })) as bigint;
    const provider = (await client.readContract({ address: c.cfg.aave.pool, abi: AAVE_ABI, functionName: 'ADDRESSES_PROVIDER' })) as Address;
    const provOk = provider.toLowerCase() === c.cfg.aave.poolAddressesProvider.toLowerCase();
    console.log(`  ✅ Aave Pool ${c.cfg.aave.pool}`);
    console.log(`     reserves: ${reserves.length} · FLASHLOAN_PREMIUM_TOTAL: ${premium} (${Number(premium) / 100}% ${premium === 5n ? '✓ 0.05%' : '⚠️'})`);
    console.log(`     ADDRESSES_PROVIDER bate com config: ${provOk ? '✓' : '⚠️ DIVERGE'}`);
  } catch (e) {
    console.log(`  ❌ Aave falhou: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }

  // 2) Uniswap V3 — factory + pool ABI (resolve + lê estado de um par major)
  try {
    const a = c.cfg.tokens[c.uniPair[0]] as Address | undefined;
    const b = c.cfg.tokens[c.uniPair[1]] as Address | undefined;
    const factory = c.cfg.uniswapV3.factory as Address | undefined;
    if (a && b && factory) {
      const pool = await getUniV3PoolAddress({ client, factory, tokenA: a, tokenB: b, fee: 500 });
      if (pool) {
        const st = await readUniV3PoolState({ client, pool });
        console.log(`  ✅ UniV3 ${c.uniPair[0]}/${c.uniPair[1]} (0.05%): pool ${pool} · sqrtPriceX96 ${st?.sqrtPriceX96 ?? '?'} · liq ${st?.liquidity ?? '?'}`);
      } else {
        console.log(`  ⚠️  UniV3 ${c.uniPair[0]}/${c.uniPair[1]} (0.05%): pool não existe nesse fee tier`);
      }
    }
  } catch (e) {
    console.log(`  ❌ UniV3 falhou: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }

  // 3) Trader Joe LB (só Avalanche) — factory + LBPair ABI
  if (c.tjPair && c.cfg.traderJoe) {
    try {
      const a = c.cfg.tokens[c.tjPair[0]] as Address;
      const b = c.cfg.tokens[c.tjPair[1]] as Address;
      const pairs = await getTraderJoePairs({ client, factory: c.cfg.traderJoe.lbFactory, tokenA: a, tokenB: b });
      console.log(`  ✅ Trader Joe LB ${c.tjPair[0]}/${c.tjPair[1]}: ${pairs.length} pair(s) — bin steps ${pairs.map((p) => p.binStep).join(',')}`);
      // Acha o pair mais fundo + VALIDA a orientação do spot via getSwapOut (1 WAVAX → USDC)
      let best: { pair: Address; tokenX: Address; liq: bigint } | null = null;
      for (const p of pairs) {
        const st = await readLBPairState({ client, pair: p.pair });
        if (!st || st.reserveX === 0n || st.reserveY === 0n) continue;
        const liq = st.reserveX + st.reserveY;
        if (!best || liq > best.liq) best = { pair: p.pair, tokenX: st.tokenX, liq };
      }
      if (best) {
        const swapForY = best.tokenX.toLowerCase() === a.toLowerCase();
        const q = await quoteTraderJoe({ client, pair: best.pair, amountIn: parseUnits('1', 18), swapForY });
        if (q && q.amountOut > 0n) {
          const spot = lbSwapOutToSpot1e18({ amountIn: parseUnits('1', 18), amountInLeft: q.amountInLeft, amountOut: q.amountOut, fee: q.fee, decimalsIn: 18, decimalsOut: 6 });
          const usd = Number(formatUnits(spot, 18));
          const sane = usd > 3 && usd < 500; // AVAX historicamente $5-$200
          console.log(`     spot WAVAX→USDC (getSwapOut): $${usd.toFixed(2)} ${sane ? '✓ orientação/decimais OK' : '⚠️ FORA DA FAIXA — revisar'} (pair ${best.pair})`);
        }
      }
    } catch (e) {
      console.log(`  ❌ Trader Joe falhou: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
  }
}

async function main() {
  console.log('🔍 Confirmação on-chain: endereços + ABIs + premium flashloan (eth_call, free tier)');
  for (const c of CHAINS) await confirmChain(c);
  console.log('\n✅ Concluído.');
}
main().catch((e) => { console.error(e); process.exit(1); });
