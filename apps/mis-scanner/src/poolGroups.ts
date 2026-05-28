/**
 * Curadoria de pool groups pro MIS — pares da tese (LSD/stable sub-servidos em Base).
 *
 * NÃO hardcoda endereços de pool (que eu poderia errar) — define PARES + tipos,
 * e o resolver descobre os pools on-chain via factory (UniV3 getPool + Aerodrome getPool).
 * Os TOKENS vêm do chain-config (já curados).
 */

import type { Address, PublicClient } from 'viem';
import { getUniV3PoolAddress, getAeroPoolAddress } from '@zeus-evm/dex-adapters';
import type { PoolGroup, PoolRef } from '@zeus-evm/execution-utils';
import type { ChainConfig } from '@zeus-evm/chain-config';

type AnyPublicClient = PublicClient<any, any>;

/** Par curado pra monitorar (tese: LSD/stable + majors como benchmark). */
interface CuratedPair {
  label: string;
  tokenAKey: string; // chave em chainConfig.tokens
  tokenBKey: string;
  decimalsA: number;
  decimalsB: number;
  /** Tenta pool stable do Aerodrome? (true pra stable/stable e LSD/ETH). */
  aeroStable: boolean;
  aeroVolatile: boolean;
}

/**
 * Pares iniciais (Base) — foco na tese de ativos ancorados em mercados sub-servidos.
 * Ajustar conforme o MIS revelar quais têm ineficiência persistente.
 */
export const BASE_CURATED_PAIRS: CuratedPair[] = [
  // LSD ancorado ao ETH — divergência de peg, edge de modelo AMM (stable pool no Aero)
  { label: 'cbETH/WETH', tokenAKey: 'cbETH', tokenBKey: 'WETH', decimalsA: 18, decimalsB: 18, aeroStable: true, aeroVolatile: true },
  // Stable/stable — depeg pequeno recorrente
  { label: 'USDC/USDbC', tokenAKey: 'USDC', tokenBKey: 'USDbC', decimalsA: 6, decimalsB: 6, aeroStable: true, aeroVolatile: false },
  { label: 'DAI/USDC', tokenAKey: 'DAI', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: true, aeroVolatile: false },
  { label: 'USDT/USDC', tokenAKey: 'USDT', tokenBKey: 'USDC', decimalsA: 6, decimalsB: 6, aeroStable: true, aeroVolatile: false },
  // Majors — benchmark de liquidez profunda (alta competição, baixo edge — controle)
  { label: 'WETH/USDC', tokenAKey: 'WETH', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: false, aeroVolatile: true },
  { label: 'cbETH/USDC', tokenAKey: 'cbETH', tokenBKey: 'USDC', decimalsA: 18, decimalsB: 6, aeroStable: false, aeroVolatile: true },
  // Governance — volatilidade + liquidez fragmentada
  { label: 'AERO/WETH', tokenAKey: 'AERO', tokenBKey: 'WETH', decimalsA: 18, decimalsB: 18, aeroStable: false, aeroVolatile: true },
];

/**
 * Resolve os pools on-chain de cada par curado e monta os PoolGroups pro MIS.
 * Pula par se algum token ausente no chain-config ou se < 2 pools resolvidos.
 */
export async function resolvePoolGroups(opts: {
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  pairs: CuratedPair[];
  logger?: { info: (o: unknown, m?: string) => void; debug?: (o: unknown, m?: string) => void };
}): Promise<PoolGroup[]> {
  const { client, chainConfig, pairs, logger } = opts;
  const uniFactory = chainConfig.uniswapV3?.factory as Address | undefined;
  const aeroFactory = chainConfig.aerodrome?.factory as Address | undefined;
  const feeTiers = chainConfig.uniswapV3?.feeTiers ?? [100, 500, 3000, 10000];

  const groups: PoolGroup[] = [];

  for (const pair of pairs) {
    const tokenA = chainConfig.tokens[pair.tokenAKey] as Address | undefined;
    const tokenB = chainConfig.tokens[pair.tokenBKey] as Address | undefined;
    if (!tokenA || !tokenB) {
      logger?.debug?.({ pair: pair.label }, 'token ausente no chain-config — skip');
      continue;
    }

    const pools: PoolRef[] = [];

    // UniV3: 1 pool por fee tier (resolve via factory)
    if (uniFactory) {
      for (const fee of feeTiers) {
        const pool = await getUniV3PoolAddress({ client, factory: uniFactory, tokenA, tokenB, fee });
        if (pool) pools.push({ dex: 'univ3', pool, label: `UniV3-${fee}` });
      }
    }

    // Aerodrome: stable e/ou volatile (resolve via factory)
    if (aeroFactory) {
      if (pair.aeroStable) {
        const pool = await getAeroPoolAddress({ client, factory: aeroFactory, tokenA, tokenB, stable: true });
        if (pool) pools.push({ dex: 'aerodrome', pool, label: 'Aero-stable' });
      }
      if (pair.aeroVolatile) {
        const pool = await getAeroPoolAddress({ client, factory: aeroFactory, tokenA, tokenB, stable: false });
        if (pool) pools.push({ dex: 'aerodrome', pool, label: 'Aero-volatile' });
      }
    }

    if (pools.length < 2) {
      logger?.debug?.({ pair: pair.label, pools: pools.length }, 'menos de 2 pools — skip (sem comparação)');
      continue;
    }

    groups.push({
      label: pair.label,
      tokenA,
      tokenB,
      decimalsA: pair.decimalsA,
      decimalsB: pair.decimalsB,
      pools,
    });
    logger?.info?.({ pair: pair.label, pools: pools.length }, `📍 grupo resolvido: ${pair.label} (${pools.length} pools)`);
  }

  return groups;
}
