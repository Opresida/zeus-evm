/**
 * Trader Joe v2.2 "Liquidity Book" (LB) — adapter pro MIS (Motor 2 na Avalanche).
 *
 * LB é um AMM por BINS (não constant-product nem concentrated-liquidity do UniV3).
 * Cada bin tem um preço discreto: price = (1 + binStep/1e4)^(activeId - 2^23).
 *
 * DECISÃO DE RISCO (importante): em vez de replicar a math de preço por bin (128.128
 * fixed-point, orientação X/Y ambígua na doc — meu limite de conhecimento), derivamos
 * o spot DIRETO do contrato via `getSwapOut` (que é VIEW). O próprio LBPair calcula o
 * output exato de um swap — zero risco de orientação/decimais. Usamos um probe pequeno
 * (1 token de entrada) e removemos a fee pra aproximar o mid-price (comparável ao mid do
 * UniV3). O mesmo `getSwapOut` serve pro quote exato do flash estimator.
 *
 * VALIDAÇÃO PENDENTE: precisa de fork test contra Avalanche real (requer AVALANCHE_RPC_HTTP)
 * antes de confiar no ranking ao vivo. O quote exato (getSwapOut) protege o capital de
 * qualquer forma — o pior caso de um spot errado é mis-ranking, não trade ruim.
 *
 * Fontes (verificadas 2026-05-29): joe-v2 ILBPair/ILBFactory; LFJ docs (endereços).
 */

import type { Address, PublicClient } from 'viem';

type AnyPublicClient = PublicClient<any, any>;

const WAD = 10n ** 18n;
const ZERO = '0x0000000000000000000000000000000000000000';

/** LBFactory v2.2 (Avalanche): 0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c */
export const LB_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getAllLBPairs',
    stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'tokenX' },
      { type: 'address', name: 'tokenY' },
    ],
    outputs: [
      {
        type: 'tuple[]',
        name: 'lbPairsAvailable',
        components: [
          { type: 'uint16', name: 'binStep' },
          { type: 'address', name: 'LBPair' },
          { type: 'bool', name: 'createdByOwner' },
          { type: 'bool', name: 'ignoredForRouting' },
        ],
      },
    ],
  },
] as const;

export const LB_PAIR_ABI = [
  { type: 'function', name: 'getActiveId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { type: 'function', name: 'getBinStep', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint128', name: 'reserveX' },
      { type: 'uint128', name: 'reserveY' },
    ],
  },
  { type: 'function', name: 'getTokenX', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getTokenY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'getSwapOut',
    stateMutability: 'view',
    inputs: [
      { type: 'uint128', name: 'amountIn' },
      { type: 'bool', name: 'swapForY' },
    ],
    outputs: [
      { type: 'uint128', name: 'amountInLeft' },
      { type: 'uint128', name: 'amountOut' },
      { type: 'uint128', name: 'fee' },
    ],
  },
] as const;

export interface LBPairRef {
  pair: Address;
  binStep: number;
}

export interface LBPairState {
  pair: Address;
  tokenX: Address;
  tokenY: Address;
  binStep: number;
  reserveX: bigint;
  reserveY: bigint;
  activeId: number;
}

/**
 * Resolve TODOS os LB pairs de um par de tokens (1 call → todos os bin steps).
 * Filtra os ignorados pra routing (ignoredForRouting).
 */
export async function getTraderJoePairs(opts: {
  client: AnyPublicClient;
  factory: Address;
  tokenA: Address;
  tokenB: Address;
}): Promise<LBPairRef[]> {
  const { client, factory, tokenA, tokenB } = opts;
  try {
    const res = (await client.readContract({
      address: factory,
      abi: LB_FACTORY_ABI,
      functionName: 'getAllLBPairs',
      args: [tokenA, tokenB],
    })) as ReadonlyArray<{ binStep: number; LBPair: Address; createdByOwner: boolean; ignoredForRouting: boolean }>;
    return res
      .filter((p) => p.LBPair !== ZERO && !p.ignoredForRouting)
      .map((p) => ({ pair: p.LBPair, binStep: Number(p.binStep) }));
  } catch {
    return [];
  }
}

/** Lê estado de um LBPair (tokens + binStep + reserves + activeId) via multicall. */
export async function readLBPairState(opts: {
  client: AnyPublicClient;
  pair: Address;
}): Promise<LBPairState | null> {
  const { client, pair } = opts;
  const calls = [
    { address: pair, abi: LB_PAIR_ABI, functionName: 'getTokenX' as const },
    { address: pair, abi: LB_PAIR_ABI, functionName: 'getTokenY' as const },
    { address: pair, abi: LB_PAIR_ABI, functionName: 'getBinStep' as const },
    { address: pair, abi: LB_PAIR_ABI, functionName: 'getReserves' as const },
    { address: pair, abi: LB_PAIR_ABI, functionName: 'getActiveId' as const },
  ];
  const [tx, ty, bs, rs, aid] = await client.multicall({ contracts: calls, allowFailure: true });
  if (tx?.status !== 'success' || ty?.status !== 'success') return null;
  const reserves = rs?.status === 'success' ? (rs.result as readonly [bigint, bigint]) : [0n, 0n];
  return {
    pair,
    tokenX: tx.result as Address,
    tokenY: ty.result as Address,
    binStep: bs?.status === 'success' ? Number(bs.result) : 0,
    reserveX: reserves[0],
    reserveY: reserves[1],
    activeId: aid?.status === 'success' ? Number(aid.result) : 0,
  };
}

/**
 * Quote exato (view) de um swap no LBPair. swapForY=true → entra tokenX, sai tokenY.
 * Retorna amountOut + fee + amountInLeft (sobra não-swapada = pool raso pro tamanho).
 */
export async function quoteTraderJoe(opts: {
  client: AnyPublicClient;
  pair: Address;
  amountIn: bigint;
  swapForY: boolean;
}): Promise<{ amountOut: bigint; fee: bigint; amountInLeft: bigint } | null> {
  const { client, pair, amountIn, swapForY } = opts;
  try {
    const res = (await client.readContract({
      address: pair,
      abi: LB_PAIR_ABI,
      functionName: 'getSwapOut',
      args: [amountIn, swapForY],
    })) as readonly [bigint, bigint, bigint];
    return { amountInLeft: res[0], amountOut: res[1], fee: res[2] };
  } catch {
    return null;
  }
}

/**
 * Spot price (OUT por IN, 1e18) a partir de um resultado de getSwapOut.
 * Remove a fee e a sobra não-swapada pra aproximar o mid-price (comparável ao UniV3 mid).
 * Retorna 0n se o input efetivo for não-positivo (pool raso demais até pro probe).
 */
export function lbSwapOutToSpot1e18(args: {
  amountIn: bigint;
  amountInLeft: bigint;
  amountOut: bigint;
  fee: bigint;
  decimalsIn: number;
  decimalsOut: number;
}): bigint {
  const { amountIn, amountInLeft, amountOut, fee, decimalsIn, decimalsOut } = args;
  const effectiveIn = amountIn - amountInLeft - fee; // input que de fato virou output, sem fee (≈ mid)
  if (effectiveIn <= 0n || amountOut <= 0n) return 0n;
  // spot = (amountOut/10^decOut) / (effectiveIn/10^decIn) * 1e18
  return (amountOut * 10n ** BigInt(decimalsIn) * WAD) / (effectiveIn * 10n ** BigInt(decimalsOut));
}
