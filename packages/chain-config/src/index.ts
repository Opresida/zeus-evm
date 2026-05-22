export type { ChainConfig } from './types';
export { BASE_MAINNET } from './base';
export { BASE_TARGET_PAIRS, findPairById } from './target-pairs';
export type { TargetPair } from './target-pairs';

import { BASE_MAINNET } from './base';
import type { ChainConfig } from './types';

/** Registry de todas as chains suportadas. Adicionar Arbitrum/Optimism aqui. */
export const CHAINS: Record<number, ChainConfig> = {
  [BASE_MAINNET.chainId]: BASE_MAINNET,
};

/** Helper para resolver config por chainId */
export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAINS[chainId];
  if (!config) {
    throw new Error(`ChainConfig not found for chainId=${chainId}`);
  }
  return config;
}
