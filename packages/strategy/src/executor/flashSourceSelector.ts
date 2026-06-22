/**
 * Seletor de fonte de flashloan pro motor de ARB/BACKRUN (espelha o do liquidator).
 *
 * Prioridade econômica: Morpho (0%) → Balancer (0%) → Aave (0,05% fallback universal).
 * A escolha é OFF-CHAIN; o contrato só executa o caminho escolhido (campo `flashSource` no struct).
 * O profit math permanece conservador a 0,05% nos calculators — o ganho de 5bps é capturado on-chain
 * quando a fonte 0% é usada.
 *
 * Self-contained de propósito (sem depender de @zeus-evm/shared-types): os valores do enum DEVEM
 * bater com o Solidity (`enum FlashSource`) e com `@zeus-evm/shared-types`. Mesmo padrão do
 * `apps/liquidator/src/types.ts`.
 */

import type { Address, PublicClient } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';

type AnyPublicClient = PublicClient<any, any>;

/** Valores devem bater com o enum FlashSource do Solidity + shared-types. */
export const FLASH_SOURCE = { Aave: 0, Morpho: 1, Balancer: 2 } as const;
export const FLASH_PREMIUM_BPS: Record<number, bigint> = { 0: 5n, 1: 0n, 2: 0n };

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface FlashSourceSelection {
  /** 0 = Aave, 1 = Morpho, 2 = Balancer. */
  flashSource: number;
  flashPremiumBps: bigint;
}

export interface FlashLiquidity {
  morpho: bigint;
  balancer: bigint;
}

/**
 * Decisão pura: dada a quantia e a liquidez 0% disponível, escolhe a melhor fonte.
 * Exige `bufferBps` a mais de liquidez (default 1%) — flashloan sem folga reverte (não perde
 * dinheiro, perde a oportunidade). Determinística → unit-testável.
 */
export function pickFlashSourceByLiquidity(
  amount: bigint,
  liquidity: FlashLiquidity,
  bufferBps = 100n,
): FlashSourceSelection {
  const required = (amount * (10_000n + bufferBps)) / 10_000n;
  if (liquidity.morpho >= required) {
    return { flashSource: FLASH_SOURCE.Morpho, flashPremiumBps: FLASH_PREMIUM_BPS[FLASH_SOURCE.Morpho]! };
  }
  if (liquidity.balancer >= required) {
    return { flashSource: FLASH_SOURCE.Balancer, flashPremiumBps: FLASH_PREMIUM_BPS[FLASH_SOURCE.Balancer]! };
  }
  return { flashSource: FLASH_SOURCE.Aave, flashPremiumBps: FLASH_PREMIUM_BPS[FLASH_SOURCE.Aave]! };
}

/** Lê o saldo do `token` no singleton Morpho + Vault Balancer (1 multicall). Fonte ausente → 0n. */
export async function probeFlashLiquidity(
  client: AnyPublicClient,
  chainConfig: ChainConfig,
  token: Address,
): Promise<FlashLiquidity> {
  const morphoAddr = chainConfig.morpho?.morphoBlue;
  const balancerAddr = chainConfig.balancer?.vault;

  const calls: { address: Address; abi: typeof ERC20_BALANCE_OF_ABI; functionName: 'balanceOf'; args: [Address] }[] = [];
  if (morphoAddr) calls.push({ address: token, abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [morphoAddr] });
  if (balancerAddr) calls.push({ address: token, abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [balancerAddr] });

  if (calls.length === 0) return { morpho: 0n, balancer: 0n };

  const results = await client.multicall({ contracts: calls, allowFailure: true });

  let idx = 0;
  let morpho = 0n;
  let balancer = 0n;
  if (morphoAddr) {
    const r = results[idx++];
    morpho = r?.status === 'success' ? (r.result as bigint) : 0n;
  }
  if (balancerAddr) {
    const r = results[idx++];
    balancer = r?.status === 'success' ? (r.result as bigint) : 0n;
  }
  return { morpho, balancer };
}

/**
 * Seleção end-to-end: probe on-chain + decisão pura. Qualquer erro de RPC → fail-safe pro Aave.
 */
export async function selectFlashSource(
  client: AnyPublicClient,
  chainConfig: ChainConfig,
  token: Address,
  amount: bigint,
): Promise<FlashSourceSelection> {
  try {
    const liquidity = await probeFlashLiquidity(client, chainConfig, token);
    return pickFlashSourceByLiquidity(amount, liquidity);
  } catch {
    return { flashSource: FLASH_SOURCE.Aave, flashPremiumBps: FLASH_PREMIUM_BPS[FLASH_SOURCE.Aave]! };
  }
}
