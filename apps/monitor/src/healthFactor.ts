/**
 * Health Factor engine — calcula HF real-time on-chain pra uma lista de usuários.
 *
 * O subgraph dá uma lista broad de positions (com debt > X), mas health factor
 * preciso só tem ON-CHAIN porque depende de:
 *   - Preço atualizado de cada asset (Aave Oracle)
 *   - Estado atual de cada reserve (liquidation threshold, normalized income, etc)
 *   - Position do user agora (que pode ter mudado entre o subgraph indexar e nós lermos)
 *
 * Usamos `IPool.getUserAccountData(user)` que retorna HF já calculado pelo Aave.
 *
 * Returns HF como BigInt (1e18 base) — multiplicar por 1e-18 pra valor decimal.
 * Aave: healthFactor < 1e18 → liquidável.
 */

import { type Address, type PublicClient, parseAbi } from 'viem';

const POOL_ABI = parseAbi([
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
]);

type AnyClient = PublicClient<any, any>;

export interface UserAccountData {
  user: Address;
  totalCollateralBase: bigint; // USD com 8 decimals (Aave base currency)
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint; // 1e4 = 100%
  ltv: bigint;
  healthFactor: bigint; // 1e18 = HF 1.0
}

/** Converte HF bigint (1e18 base) pra número decimal. Cap em 999 pra evitar overflow visual. */
export function hfToNumber(hf: bigint): number {
  if (hf > 999_000_000_000_000_000_000n) return 999;
  return Number(hf) / 1e18;
}

/** Converte base value (1e8) pra USD float */
export function baseToUsd(base: bigint): number {
  return Number(base) / 1e8;
}

/**
 * Busca dados de account pra UM user via Aave Pool.
 */
export async function getUserAccountData(
  client: AnyClient,
  poolAddress: Address,
  user: Address,
): Promise<UserAccountData> {
  const result = await client.readContract({
    address: poolAddress,
    abi: POOL_ABI,
    functionName: 'getUserAccountData',
    args: [user],
  });

  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  ] = result as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

  return {
    user,
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  };
}

/**
 * Busca account data pra MUITOS users em paralelo (com controle de concorrência).
 * Default: 10 chamadas concorrentes (não sobrecarrega RPC).
 */
export async function getUserAccountDataBatch(
  client: AnyClient,
  poolAddress: Address,
  users: Address[],
  concurrency: number = 10,
): Promise<UserAccountData[]> {
  const results: UserAccountData[] = [];
  for (let i = 0; i < users.length; i += concurrency) {
    const batch = users.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((u) => getUserAccountData(client, poolAddress, u).catch((err) => ({ user: u, error: err }))),
    );
    for (const r of batchResults) {
      if ('healthFactor' in r) results.push(r);
    }
  }
  return results;
}

/**
 * Filtra users com HF abaixo do threshold (default 1.05 = "em risco").
 * Ordena por HF ascendente (mais próximo de liquidar primeiro).
 */
export function filterAtRisk(
  users: UserAccountData[],
  thresholdNumber: number = 1.05,
): UserAccountData[] {
  const threshold = BigInt(Math.floor(thresholdNumber * 1e18));
  return users
    .filter((u) => u.totalDebtBase > 0n && u.healthFactor < threshold)
    .sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1));
}
