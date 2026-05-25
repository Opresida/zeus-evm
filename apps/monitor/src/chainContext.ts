/**
 * Resolve contexto de chain a partir de CHAIN_ID + .env vars.
 *
 * Cada chain precisa de:
 *   - chain config (de @zeus-evm/chain-config)
 *   - RPC URL (do .env)
 *   - Subgraph ID Aave V3 (do .env, com defaults oficiais)
 *
 * Suporta 3 mainnets ativos: Base (8453), Arbitrum (42161), Optimism (10).
 * Sepolia versions também suportadas pra deploys testnet.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import {
  ARBITRUM_MAINNET,
  ARBITRUM_SEPOLIA,
  BASE_MAINNET,
  BASE_SEPOLIA,
  OPTIMISM_MAINNET,
  OPTIMISM_SEPOLIA,
  type ChainConfig,
} from '@zeus-evm/chain-config';
import { arbitrum, arbitrumSepolia, base, baseSepolia, optimism, optimismSepolia } from 'viem/chains';

import type { MonitorEnv } from './config';

type AnyClient = PublicClient<any, any>;

export interface ChainContext {
  chainConfig: ChainConfig;
  rpcUrl: string;
  subgraphId: string;
  client: AnyClient;
}

export function getChainContext(env: MonitorEnv): ChainContext {
  const chainId = env.CHAIN_ID;

  switch (chainId) {
    case 8453:
      return buildContext(BASE_MAINNET, env.BASE_RPC_HTTP, env.AAVE_V3_BASE_SUBGRAPH_ID, base);
    case 84532:
      return buildContext(BASE_SEPOLIA, env.BASE_SEPOLIA_RPC_HTTP, env.AAVE_V3_BASE_SUBGRAPH_ID, baseSepolia);
    case 42161:
      return buildContext(ARBITRUM_MAINNET, env.ARBITRUM_RPC_HTTP, env.AAVE_V3_ARBITRUM_SUBGRAPH_ID, arbitrum);
    case 421614:
      return buildContext(
        ARBITRUM_SEPOLIA,
        env.ARBITRUM_SEPOLIA_RPC_HTTP,
        env.AAVE_V3_ARBITRUM_SUBGRAPH_ID,
        arbitrumSepolia,
      );
    case 10:
      return buildContext(OPTIMISM_MAINNET, env.OPTIMISM_RPC_HTTP, env.AAVE_V3_OPTIMISM_SUBGRAPH_ID, optimism);
    case 11155420:
      return buildContext(
        OPTIMISM_SEPOLIA,
        env.OPTIMISM_SEPOLIA_RPC_HTTP,
        env.AAVE_V3_OPTIMISM_SUBGRAPH_ID,
        optimismSepolia,
      );
    default:
      throw new Error(
        `CHAIN_ID=${chainId} não suportado. Use: 8453 (Base), 42161 (Arbitrum), 10 (Optimism), ou testnets 84532/421614/11155420.`,
      );
  }
}

function buildContext(
  chainConfig: ChainConfig,
  rpcUrl: string | undefined,
  subgraphId: string,
  viemChain: { id: number; name: string },
): ChainContext {
  if (!rpcUrl) {
    throw new Error(
      `RPC URL não configurada pra chain ${chainConfig.name} (chainId=${chainConfig.chainId}). Verifique .env.`,
    );
  }

  const client = createPublicClient({
    chain: viemChain as any,
    transport: http(rpcUrl),
  });

  return { chainConfig, rpcUrl, subgraphId, client };
}
