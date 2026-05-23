/**
 * Discovery — escaneia pools UniV3 + Aerodrome pra cada token candidato.
 *
 * Pra cada (TOKEN, QUOTE) em [token candidate] × [WETH, USDC]:
 *   - UniV3: tenta `getPool(token, quote, fee)` pra cada fee tier (100, 500, 3000, 10000)
 *   - Aerodrome: tenta `getPool(token, quote, stable=false|true)`
 *   - Pra cada pool encontrado: calcula TVL via balanceOf do quote token
 *
 * Reporta:
 *   - Pares VIÁVEIS pra cross-DEX (existem em ambos UniV3 e Aerodrome com TVL > MIN_TVL_USD)
 *   - Pares parciais (só 1 DEX) — pra debug
 *
 * Uso: pnpm --filter @zeus-evm/backtest exec tsx src/discover-pairs.ts
 */

import 'dotenv/config';
import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  type Address,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import pino from 'pino';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../../../.env') });

const logger = pino({
  level: 'info',
  base: { app: 'zeus-evm-discover' },
  transport: process.env.NODE_ENV === 'production' ? undefined : {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss' },
  },
});

// ─── Addresses Base mainnet ───
const UNI_V3_FACTORY: Address = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AERO_FACTORY: Address = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

const WETH: Address = '0x4200000000000000000000000000000000000006';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const UNI_V3_FEES = [100, 500, 3000, 10000] as const;

// ─── Pricing assumptions (manual cutoff) ───
// Pra calcular TVL aproximado. Mainnet em 2026-05-23: ETH ~$2110.
// Override via env se quiser refinar.
const ETH_PRICE_USD = Number(process.env.ETH_PRICE_USD ?? 2110);
const MIN_TVL_USD = Number(process.env.MIN_TVL_USD ?? 50_000);

// ─── Tokens candidate (validados on-chain) ───
interface TokenInfo {
  symbol: string;
  address: Address;
  decimals: number;
  category: 'memecoin' | 'ai' | 'lst' | 'dex';
}

const CANDIDATES: TokenInfo[] = [
  // Memecoins alta-vol
  { symbol: 'DEGEN',   address: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', decimals: 18, category: 'memecoin' },
  { symbol: 'BRETT',   address: '0x532f27101965dd16442e59d40670faf5ebb142e4', decimals: 18, category: 'memecoin' },
  { symbol: 'TOSHI',   address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', decimals: 18, category: 'memecoin' },
  { symbol: 'HIGHER',  address: '0x0578d8a44db98b23bf096a382e016e29a5ce0ffe', decimals: 18, category: 'memecoin' },
  // AI agents
  { symbol: 'AIXBT',   address: '0x121ed556713ed543c3c14dcbcd9238d12e380a5f', decimals: 18, category: 'ai' },
  { symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', decimals: 18, category: 'ai' },
  // LSTs
  { symbol: 'wstETH',  address: '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', decimals: 18, category: 'lst' },
  { symbol: 'cbETH',   address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, category: 'lst' },
  // DEX token (Aerodrome) — sabemos que tem pools UniV3+Aerodrome
  { symbol: 'AERO',    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18, category: 'dex' },
];

const QUOTES: { symbol: 'WETH' | 'USDC'; address: Address; decimals: number; priceUsd: number }[] = [
  { symbol: 'WETH', address: WETH, decimals: 18, priceUsd: ETH_PRICE_USD },
  { symbol: 'USDC', address: USDC, decimals: 6,  priceUsd: 1 },
];

// ─── ABIs ───
const UNI_V3_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);
const AERO_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
]);
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

type AnyClient = PublicClient<any, any>;

interface PoolInfo {
  dex: 'uniV3' | 'aerodrome';
  variant: string; // fee tier ou stable/volatile
  poolAddress: Address;
  tvlUsd: number;
  quoteSymbol: string;
}

interface DiscoveryResult {
  token: TokenInfo;
  quote: string;
  pools: PoolInfo[];
}

async function getQuoteBalance(
  client: AnyClient,
  pool: Address,
  quoteAddr: Address,
): Promise<bigint> {
  return await client.readContract({
    address: quoteAddr,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [pool],
  });
}

function tvlFromQuoteBalance(balance: bigint, quoteDecimals: number, quotePrice: number): number {
  const balanceFloat = Number(formatUnits(balance, quoteDecimals));
  // TVL total ≈ 2 × balance do quote (assumindo pool ~50/50)
  return balanceFloat * quotePrice * 2;
}

async function checkUniV3Pool(
  client: AnyClient,
  token: TokenInfo,
  quote: typeof QUOTES[number],
  fee: number,
): Promise<PoolInfo | null> {
  const poolAddress = await client.readContract({
    address: UNI_V3_FACTORY,
    abi: UNI_V3_FACTORY_ABI,
    functionName: 'getPool',
    args: [token.address, quote.address, fee],
  }) as Address;

  if (poolAddress === ZERO_ADDR) return null;

  const quoteBalance = await getQuoteBalance(client, poolAddress, quote.address);
  const tvlUsd = tvlFromQuoteBalance(quoteBalance, quote.decimals, quote.priceUsd);

  return {
    dex: 'uniV3',
    variant: `fee${fee}`,
    poolAddress,
    tvlUsd,
    quoteSymbol: quote.symbol,
  };
}

async function checkAerodromePool(
  client: AnyClient,
  token: TokenInfo,
  quote: typeof QUOTES[number],
  stable: boolean,
): Promise<PoolInfo | null> {
  const poolAddress = await client.readContract({
    address: AERO_FACTORY,
    abi: AERO_FACTORY_ABI,
    functionName: 'getPool',
    args: [token.address, quote.address, stable],
  }) as Address;

  if (poolAddress === ZERO_ADDR) return null;

  const quoteBalance = await getQuoteBalance(client, poolAddress, quote.address);
  const tvlUsd = tvlFromQuoteBalance(quoteBalance, quote.decimals, quote.priceUsd);

  return {
    dex: 'aerodrome',
    variant: stable ? 'stable' : 'volatile',
    poolAddress,
    tvlUsd,
    quoteSymbol: quote.symbol,
  };
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry simples: tenta 3 vezes com backoff exponencial. */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message.slice(0, 80) : String(err);
      if (attempt < 3) {
        const backoffMs = 1000 * attempt;
        logger.debug(`${label} attempt ${attempt} failed (${msg}), retry em ${backoffMs}ms`);
        await sleep(backoffMs);
      }
    }
  }
  throw lastErr;
}

async function discoverToken(client: AnyClient, token: TokenInfo): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];

  for (const quote of QUOTES) {
    if (quote.address.toLowerCase() === token.address.toLowerCase()) continue;

    const pools: PoolInfo[] = [];

    // UniV3 — sequencial com retry
    for (const fee of UNI_V3_FEES) {
      try {
        const p = await withRetry(
          () => checkUniV3Pool(client, token, quote, fee),
          `UniV3 ${token.symbol}/${quote.symbol} fee${fee}`,
        );
        if (p) pools.push(p);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message.slice(0, 100) : err, token: token.symbol, quote: quote.symbol, fee },
          `UniV3 ${token.symbol}/${quote.symbol} fee${fee} falhou (após retries)`,
        );
      }
      await sleep(200);
    }

    // Aerodrome — sequencial com retry
    for (const stable of [false, true]) {
      try {
        const p = await withRetry(
          () => checkAerodromePool(client, token, quote, stable),
          `Aero ${token.symbol}/${quote.symbol} ${stable ? 'stable' : 'volatile'}`,
        );
        if (p) pools.push(p);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message.slice(0, 100) : err, token: token.symbol, quote: quote.symbol, stable },
          `Aero ${token.symbol}/${quote.symbol} ${stable ? 'stable' : 'volatile'} falhou (após retries)`,
        );
      }
      await sleep(200);
    }

    results.push({ token, quote: quote.symbol, pools });
  }

  return results;
}

async function main() {
  const rpcUrl = process.env.BASE_RPC_HTTP;
  if (!rpcUrl) throw new Error('BASE_RPC_HTTP não definido');

  const client: AnyClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  logger.info(
    {
      candidates: CANDIDATES.length,
      quotes: QUOTES.map((q) => q.symbol),
      minTvlUsd: MIN_TVL_USD,
      ethPriceUsd: ETH_PRICE_USD,
    },
    `🔍 Discovery iniciado — ${CANDIDATES.length} tokens × ${QUOTES.length} quotes`,
  );

  const allResults: DiscoveryResult[] = [];

  for (const token of CANDIDATES) {
    logger.info({ token: token.symbol }, `→ Escaneando ${token.symbol}...`);
    const tokenResults = await discoverToken(client, token);
    allResults.push(...tokenResults);
  }

  // ─── Análise ───
  // Pares VIÁVEIS = têm pool UniV3 E pool Aerodrome com TVL > MIN_TVL_USD em pelo menos um lado
  const viable: Array<{
    pair: string;
    quote: string;
    category: string;
    uniV3Pools: PoolInfo[];
    aeroPools: PoolInfo[];
    bestUniTvl: number;
    bestAeroTvl: number;
  }> = [];

  for (const r of allResults) {
    const uniV3Pools = r.pools.filter((p) => p.dex === 'uniV3' && p.tvlUsd >= MIN_TVL_USD);
    const aeroPools = r.pools.filter((p) => p.dex === 'aerodrome' && p.tvlUsd >= MIN_TVL_USD);

    if (uniV3Pools.length > 0 && aeroPools.length > 0) {
      viable.push({
        pair: `${r.token.symbol}/${r.quote}`,
        quote: r.quote,
        category: r.token.category,
        uniV3Pools,
        aeroPools,
        bestUniTvl: Math.max(...uniV3Pools.map((p) => p.tvlUsd)),
        bestAeroTvl: Math.max(...aeroPools.map((p) => p.tvlUsd)),
      });
    }
  }

  // ─── Output ───
  logger.info({ viableCount: viable.length }, `\n✅ ${viable.length} pares VIÁVEIS pra cross-DEX (UniV3 + Aerodrome ambos com TVL > $${MIN_TVL_USD.toLocaleString()})\n`);

  // Ordena por menor TVL (mais arbitrável — pools rasos têm mais spread)
  viable.sort((a, b) => Math.min(a.bestUniTvl, a.bestAeroTvl) - Math.min(b.bestUniTvl, b.bestAeroTvl));

  for (const v of viable) {
    const uniSummary = v.uniV3Pools.map((p) => `${p.variant}=$${Math.round(p.tvlUsd / 1000)}k`).join(', ');
    const aeroSummary = v.aeroPools.map((p) => `${p.variant}=$${Math.round(p.tvlUsd / 1000)}k`).join(', ');
    logger.info(
      {
        pair: v.pair,
        category: v.category,
        uniV3: uniSummary,
        aerodrome: aeroSummary,
      },
      `  💎 ${v.pair} [${v.category}] · UniV3: {${uniSummary}} · Aero: {${aeroSummary}}`,
    );
  }

  // Pares com apenas 1 DEX (não viáveis pra cross-DEX, mas úteis pra debug)
  const partials = allResults.filter((r) => {
    const hasUni = r.pools.some((p) => p.dex === 'uniV3' && p.tvlUsd >= MIN_TVL_USD);
    const hasAero = r.pools.some((p) => p.dex === 'aerodrome' && p.tvlUsd >= MIN_TVL_USD);
    return (hasUni || hasAero) && !(hasUni && hasAero);
  });

  if (partials.length > 0) {
    logger.info(`\n⚠️  ${partials.length} pares apenas em 1 DEX (não viáveis pra cross-DEX):`);
    for (const p of partials) {
      const dexs = p.pools.filter((pp) => pp.tvlUsd >= MIN_TVL_USD).map((pp) => `${pp.dex}/${pp.variant}=$${Math.round(pp.tvlUsd / 1000)}k`).join(', ');
      logger.info(`  ⚪ ${p.token.symbol}/${p.quote} · ${dexs}`);
    }
  }

  // Save JSON
  const outputPath = resolve(__dirname, '../runs', `discover-${Date.now()}.json`);
  const serializable = {
    config: {
      minTvlUsd: MIN_TVL_USD,
      ethPriceUsd: ETH_PRICE_USD,
      candidates: CANDIDATES.length,
    },
    viable: viable.map((v) => ({
      pair: v.pair,
      quote: v.quote,
      category: v.category,
      uniV3Pools: v.uniV3Pools,
      aeroPools: v.aeroPools,
    })),
    allResults: allResults.map((r) => ({
      token: r.token.symbol,
      quote: r.quote,
      pools: r.pools,
    })),
  };

  await writeFile(outputPath, JSON.stringify(serializable, null, 2));
  logger.info({ outputPath }, `💾 Resultados salvos em ${outputPath}`);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, '🔴 Discovery crashed');
  process.exit(1);
});
