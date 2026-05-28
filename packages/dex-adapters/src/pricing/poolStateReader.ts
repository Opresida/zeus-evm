/**
 * Pool State Reader — lê o estado on-chain dos pools pra alimentar o pricing local.
 *
 * UniV3: slot0 (sqrtPriceX96) + token0/token1/fee/liquidity
 * Aerodrome/Velodrome: getReserves + token0/token1 + stable flag
 *
 * Combina com a math de pricing (uniV3Pricing/aerodromePricing) → preço spot 1e18.
 * Leitura via multicall (1 round-trip por pool batch). Cacheável p/ MIS.
 */

import type { Address, PublicClient } from 'viem';

import { uniV3SpotPrice1e18 } from './uniV3Pricing';
import { aeroSpotPrice1e18 } from './aerodromePricing';

type AnyPublicClient = PublicClient<any, any>;

export const UNIV3_POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint160', name: 'sqrtPriceX96' },
      { type: 'int24', name: 'tick' },
      { type: 'uint16', name: 'observationIndex' },
      { type: 'uint16', name: 'observationCardinality' },
      { type: 'uint16', name: 'observationCardinalityNext' },
      { type: 'uint8', name: 'feeProtocol' },
      { type: 'bool', name: 'unlocked' },
    ],
  },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
] as const;

export const AERO_POOL_ABI = [
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint256', name: 'reserve0' },
      { type: 'uint256', name: 'reserve1' },
      { type: 'uint256', name: 'blockTimestampLast' },
    ],
  },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'stable', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

const UNIV3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint24' },
    ],
    outputs: [{ type: 'address' }],
  },
] as const;

export interface UniV3PoolState {
  pool: Address;
  token0: Address;
  token1: Address;
  fee: number;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

export interface AeroPoolState {
  pool: Address;
  token0: Address;
  token1: Address;
  stable: boolean;
  reserve0: bigint;
  reserve1: bigint;
}

/**
 * Resolve o endereço de um pool UniV3 via factory.getPool.
 */
export async function getUniV3PoolAddress(opts: {
  client: AnyPublicClient;
  factory: Address;
  tokenA: Address;
  tokenB: Address;
  fee: number;
}): Promise<Address | null> {
  const { client, factory, tokenA, tokenB, fee } = opts;
  const pool = (await client.readContract({
    address: factory,
    abi: UNIV3_FACTORY_ABI,
    functionName: 'getPool',
    args: [tokenA, tokenB, fee],
  })) as Address;
  if (pool === '0x0000000000000000000000000000000000000000') return null;
  return pool;
}

/**
 * Lê estado de um pool UniV3 (slot0 + tokens + fee + liquidity) via multicall.
 */
export async function readUniV3PoolState(opts: {
  client: AnyPublicClient;
  pool: Address;
}): Promise<UniV3PoolState | null> {
  const { client, pool } = opts;
  const calls = [
    { address: pool, abi: UNIV3_POOL_ABI, functionName: 'slot0' as const },
    { address: pool, abi: UNIV3_POOL_ABI, functionName: 'token0' as const },
    { address: pool, abi: UNIV3_POOL_ABI, functionName: 'token1' as const },
    { address: pool, abi: UNIV3_POOL_ABI, functionName: 'fee' as const },
    { address: pool, abi: UNIV3_POOL_ABI, functionName: 'liquidity' as const },
  ];
  const [slot0, t0, t1, fee, liq] = await client.multicall({ contracts: calls, allowFailure: true });
  if (slot0?.status !== 'success' || t0?.status !== 'success' || t1?.status !== 'success') return null;

  const s = slot0.result as readonly [bigint, number, number, number, number, number, boolean];
  return {
    pool,
    token0: t0.result as Address,
    token1: t1.result as Address,
    fee: fee?.status === 'success' ? Number(fee.result) : 0,
    sqrtPriceX96: s[0],
    tick: Number(s[1]),
    liquidity: liq?.status === 'success' ? (liq.result as bigint) : 0n,
  };
}

/**
 * Lê estado de um pool Aerodrome (reserves + tokens + stable) via multicall.
 */
export async function readAeroPoolState(opts: {
  client: AnyPublicClient;
  pool: Address;
}): Promise<AeroPoolState | null> {
  const { client, pool } = opts;
  const calls = [
    { address: pool, abi: AERO_POOL_ABI, functionName: 'getReserves' as const },
    { address: pool, abi: AERO_POOL_ABI, functionName: 'token0' as const },
    { address: pool, abi: AERO_POOL_ABI, functionName: 'token1' as const },
    { address: pool, abi: AERO_POOL_ABI, functionName: 'stable' as const },
  ];
  const [reserves, t0, t1, stable] = await client.multicall({ contracts: calls, allowFailure: true });
  if (reserves?.status !== 'success' || t0?.status !== 'success' || t1?.status !== 'success') return null;

  const r = reserves.result as readonly [bigint, bigint, bigint];
  return {
    pool,
    token0: t0.result as Address,
    token1: t1.result as Address,
    stable: stable?.status === 'success' ? (stable.result as boolean) : false,
    reserve0: r[0],
    reserve1: r[1],
  };
}

/**
 * Spot price (token1 por token0, 1e18) de um pool UniV3 já lido.
 * Caller fornece decimals (do cache de tokens).
 */
export function uniV3StateToSpot(state: UniV3PoolState, decimals0: number, decimals1: number): bigint {
  return uniV3SpotPrice1e18(state.sqrtPriceX96, decimals0, decimals1);
}

/**
 * Spot price (token1 por token0, 1e18) de um pool Aerodrome já lido.
 */
export function aeroStateToSpot(state: AeroPoolState, decimals0: number, decimals1: number): bigint {
  return aeroSpotPrice1e18(state.stable, state.reserve0, state.reserve1, decimals0, decimals1);
}
