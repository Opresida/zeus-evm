/**
 * Derivação de tokens dos protocolos de lending — auto-popula o universo do MIS.
 *
 * Motor 1 (liquidação) e Motor 2 (arb) compartilham o MESMO dataset: o colateral
 * que liquidamos é o token que arbitramos. Em vez de hardcodar tokens (que eu
 * poderia errar), leio os reserves/markets direto dos protocolos on-chain —
 * endereços GARANTIDOS pela fonte.
 *
 * Fontes (Base):
 *   - Aave V3 core + forks (Seamless): Pool.getReservesList()
 *   - Moonwell (Compound V2 fork): Comptroller.getAllMarkets() → mToken.underlying()
 *   - Morpho Blue: eventos CreateMarket → loanToken + collateralToken
 *
 * Cada token derivado vira par contra âncoras de liquidez (WETH/USDC), e o
 * resolvePoolGroups descobre/filtra os pools reais. Pares sem 2 pools são
 * descartados — então o universo final é só onde HÁ comparação cross-DEX.
 */

import type { Address, PublicClient } from 'viem';
import { getAddress } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';
import type { ResolvedPair } from './poolGroups';

type AnyPublicClient = PublicClient<any, any>;

type Logger = {
  info: (o: unknown, m?: string) => void;
  debug?: (o: unknown, m?: string) => void;
  warn?: (o: unknown, m?: string) => void;
};

const AAVE_POOL_ABI = [
  { type: 'function', name: 'getReservesList', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
] as const;

const COMPTROLLER_ABI = [
  { type: 'function', name: 'getAllMarkets', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
] as const;

const MTOKEN_ABI = [
  { type: 'function', name: 'underlying', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const ERC20_VIEW_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

const MORPHO_CREATE_MARKET_EVENT = {
  type: 'event',
  name: 'CreateMarket',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    {
      name: 'marketParams',
      type: 'tuple',
      indexed: false,
      components: [
        { name: 'loanToken', type: 'address' },
        { name: 'collateralToken', type: 'address' },
        { name: 'oracle', type: 'address' },
        { name: 'irm', type: 'address' },
        { name: 'lltv', type: 'uint256' },
      ],
    },
  ],
} as const;

const FREE_TIER_BLOCK_RANGE = 9_999;

export interface DerivedToken {
  address: Address;
  symbol: string;
  decimals: number;
  sources: string[];
}

export interface DeriveOpts {
  /** Liga a derivação Morpho (cara — scan de eventos). Default true. */
  includeMorpho?: boolean;
  /** Lookback de blocos pro scan de eventos Morpho. Default 2M (~46 dias em Base). */
  morphoBlockLookback?: number;
  /** Âncoras de liquidez pra formar pares (chaves em chainConfig.tokens). Default WETH/USDC. */
  anchorKeys?: string[];
  /** Cap de pares derivados (proteção de boot/rate-limit). Default 60. */
  maxPairs?: number;
}

const STABLE_RE = /usd|dai/i;
const LSD_RE = /eth$/i; // cbETH, wstETH, weETH, rETH... → pool stable provável vs WETH

/** Reúne os reserve-tokens de todos os mercados Aave-compat (core + forks). */
async function fetchAaveReserveTokens(client: AnyPublicClient, pools: Address[], logger?: Logger): Promise<Address[]> {
  const out: Address[] = [];
  for (const pool of pools) {
    try {
      const list = (await client.readContract({ address: pool, abi: AAVE_POOL_ABI, functionName: 'getReservesList' })) as readonly Address[];
      out.push(...list);
    } catch (err) {
      logger?.warn?.({ pool, err: err instanceof Error ? err.message : err }, 'Aave getReservesList falhou');
    }
  }
  return out;
}

/** Underlyings dos mTokens do Moonwell (Compound V2 fork). */
async function fetchMoonwellUnderlyings(client: AnyPublicClient, comptroller: Address, logger?: Logger): Promise<Address[]> {
  try {
    const mTokens = (await client.readContract({ address: comptroller, abi: COMPTROLLER_ABI, functionName: 'getAllMarkets' })) as readonly Address[];
    const calls = mTokens.map((m) => ({ address: m, abi: MTOKEN_ABI, functionName: 'underlying' as const }));
    const res = (await client.multicall({ contracts: calls as never, allowFailure: true })) as Array<
      { status: 'success'; result: unknown } | { status: 'failure' }
    >;
    const out: Address[] = [];
    for (const r of res) if (r.status === 'success') out.push(r.result as Address);
    return out;
  } catch (err) {
    logger?.warn?.({ comptroller, err: err instanceof Error ? err.message : err }, 'Moonwell getAllMarkets falhou');
    return [];
  }
}

/** loanToken + collateralToken dos markets do Morpho Blue (via eventos CreateMarket). */
async function fetchMorphoTokens(client: AnyPublicClient, morpho: Address, blockLookback: number, logger?: Logger): Promise<Address[]> {
  try {
    const current = await client.getBlockNumber();
    const start = current > BigInt(blockLookback) ? current - BigInt(blockLookback) : 0n;
    const step = BigInt(FREE_TIER_BLOCK_RANGE);
    const out = new Set<string>();
    let totalChunks = 0;
    let failedChunks = 0;
    let firstErr = '';
    for (let from = start; from <= current; from += step + 1n) {
      const to = from + step > current ? current : from + step;
      totalChunks++;
      try {
        const logs = await client.getLogs({ address: morpho, event: MORPHO_CREATE_MARKET_EVENT, fromBlock: from, toBlock: to });
        for (const log of logs) {
          const mp = (log as { args?: { marketParams?: { loanToken?: Address; collateralToken?: Address } } }).args?.marketParams;
          if (mp?.loanToken) out.add(mp.loanToken.toLowerCase());
          if (mp?.collateralToken) out.add(mp.collateralToken.toLowerCase());
        }
      } catch (err) {
        // chunk falhou — mantém o que já temos, mas NÃO silenciosamente (visibilidade do gap)
        failedChunks++;
        if (!firstErr) firstErr = err instanceof Error ? err.message.slice(0, 120) : String(err);
      }
    }
    // Sem isto, um RPC com limite de range apertado (ex.: Alchemy free tier = 10 blocos vs o scan
    // usa FREE_TIER_BLOCK_RANGE) faria TODOS os chunks falharem e a derivação voltaria 0 tokens
    // SEM nenhum aviso — mascarando a perda de cobertura do Morpho (nosso edge principal).
    if (failedChunks > 0) {
      logger?.warn?.(
        { morpho, failedChunks, totalChunks, tokensFound: out.size, chunkRange: FREE_TIER_BLOCK_RANGE, firstErr },
        `🦋⚠️  Morpho: ${failedChunks}/${totalChunks} chunks de getLogs falharam — derivação INCOMPLETA ` +
          `(${out.size} tokens). Provável limite de range do RPC: o scan usa ${FREE_TIER_BLOCK_RANGE} blocos/chunk ` +
          `(Alchemy free tier aceita só 10). Use um RPC que aceite esse range (dRPC ok) ou reduza o chunk.`,
      );
    }
    return Array.from(out) as Address[];
  } catch (err) {
    logger?.warn?.({ morpho, err: err instanceof Error ? err.message : err }, 'Morpho event scan falhou');
    return [];
  }
}

/**
 * Deriva o universo de tokens dos protocolos de lending + lê symbol/decimals.
 * Retorna tokens únicos (dedup por endereço), com a lista de protocolos-fonte.
 */
export async function deriveProtocolTokens(args: {
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  opts?: DeriveOpts;
  logger?: Logger;
}): Promise<DerivedToken[]> {
  const { client, chainConfig, opts = {}, logger } = args;
  const includeMorpho = opts.includeMorpho ?? true;
  const morphoLookback = opts.morphoBlockLookback ?? 2_000_000;

  const sourceByToken = new Map<string, Set<string>>();
  const addTokens = (tokens: Address[], source: string) => {
    for (const t of tokens) {
      if (!t || /^0x0+$/i.test(t)) continue;
      const key = t.toLowerCase();
      const set = sourceByToken.get(key) ?? new Set<string>();
      set.add(source);
      sourceByToken.set(key, set);
    }
  };

  // Aave core + forks (mesma ABI Pool)
  const aavePools: Address[] = [];
  if (chainConfig.aave?.pool) aavePools.push(chainConfig.aave.pool);
  for (const fork of chainConfig.aaveForks ?? []) if (fork.pool) aavePools.push(fork.pool);
  if (aavePools.length > 0) {
    const t = await fetchAaveReserveTokens(client, aavePools, logger);
    addTokens(t, 'aave');
    logger?.info?.({ pools: aavePools.length, tokens: t.length }, `🏦 Aave/forks: ${t.length} reserve-tokens`);
  }

  // Moonwell
  if (chainConfig.moonwell?.comptroller) {
    const t = await fetchMoonwellUnderlyings(client, chainConfig.moonwell.comptroller, logger);
    addTokens(t, 'moonwell');
    logger?.info?.({ tokens: t.length }, `🌙 Moonwell: ${t.length} underlyings`);
  }

  // Morpho (caro — scan de eventos)
  if (includeMorpho && chainConfig.morpho?.morphoBlue) {
    logger?.info?.({ lookback: morphoLookback }, '🦋 Morpho: varrendo eventos CreateMarket (pode demorar)...');
    const t = await fetchMorphoTokens(client, chainConfig.morpho.morphoBlue, morphoLookback, logger);
    addTokens(t, 'morpho');
    logger?.info?.({ tokens: t.length }, `🦋 Morpho: ${t.length} tokens (loan+collateral)`);
  }

  // Lê symbol + decimals de todos (1 multicall)
  const addrs = Array.from(sourceByToken.keys()) as Address[];
  if (addrs.length === 0) return [];
  const metaCalls = addrs.flatMap((a) => [
    { address: a, abi: ERC20_VIEW_ABI, functionName: 'symbol' as const },
    { address: a, abi: ERC20_VIEW_ABI, functionName: 'decimals' as const },
  ]);
  const meta = (await client.multicall({ contracts: metaCalls as never, allowFailure: true, batchSize: 100 })) as Array<
    { status: 'success'; result: unknown } | { status: 'failure' }
  >;

  const out: DerivedToken[] = [];
  for (let i = 0; i < addrs.length; i++) {
    const symRes = meta[i * 2];
    const decRes = meta[i * 2 + 1];
    if (!symRes || symRes.status !== 'success' || !decRes || decRes.status !== 'success') continue;
    out.push({
      address: getAddress(addrs[i]!),
      symbol: String(symRes.result),
      decimals: Number(decRes.result),
      sources: Array.from(sourceByToken.get(addrs[i]!.toLowerCase()) ?? []),
    });
  }
  return out;
}

/**
 * Cruza tokens derivados contra âncoras de liquidez (WETH/USDC) pra gerar pares.
 * Heurística de curva Aero: stable/stable e LSD/WETH usam pool stable; resto volatile.
 */
export function buildDerivedPairs(args: {
  tokens: DerivedToken[];
  chainConfig: ChainConfig;
  opts?: DeriveOpts;
}): ResolvedPair[] {
  const { tokens, chainConfig, opts = {} } = args;
  const anchorKeys = opts.anchorKeys ?? ['WETH', 'USDC'];
  const maxPairs = opts.maxPairs ?? 60;

  const anchors = anchorKeys
    .map((key) => {
      const addr = chainConfig.tokens[key] as Address | undefined;
      if (!addr) return null;
      const decimals = key === 'USDC' || key === 'USDbC' || key === 'USDT' ? 6 : 18;
      return { key, addr, decimals };
    })
    .filter((x): x is { key: string; addr: Address; decimals: number } => x !== null);

  const out: ResolvedPair[] = [];
  for (const token of tokens) {
    for (const anchor of anchors) {
      if (token.address.toLowerCase() === anchor.addr.toLowerCase()) continue;
      const bothStable = STABLE_RE.test(token.symbol) && STABLE_RE.test(anchor.key);
      const lsdVsEth = anchor.key === 'WETH' && LSD_RE.test(token.symbol);
      const aeroStable = bothStable || lsdVsEth;
      out.push({
        label: `${token.symbol}/${anchor.key}`,
        tokenA: token.address,
        tokenB: anchor.addr,
        decimalsA: token.decimals,
        decimalsB: anchor.decimals,
        aeroStable,
        aeroVolatile: !aeroStable,
      });
    }
  }
  return out.slice(0, maxPairs);
}
