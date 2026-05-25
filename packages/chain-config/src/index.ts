export type { ChainConfig } from './types';
export { BASE_MAINNET } from './base';
export { BASE_SEPOLIA } from './base-sepolia';
export { ARBITRUM_MAINNET } from './arbitrum';
export { ARBITRUM_SEPOLIA } from './arbitrum-sepolia';
export { OPTIMISM_MAINNET } from './optimism';
export { OPTIMISM_SEPOLIA } from './optimism-sepolia';
export { BASE_TARGET_PAIRS, findPairById } from './target-pairs';
export type { TargetPair } from './target-pairs';

import { BASE_MAINNET } from './base';
import { BASE_SEPOLIA } from './base-sepolia';
import { ARBITRUM_MAINNET } from './arbitrum';
import { ARBITRUM_SEPOLIA } from './arbitrum-sepolia';
import { OPTIMISM_MAINNET } from './optimism';
import { OPTIMISM_SEPOLIA } from './optimism-sepolia';
import type { ChainConfig } from './types';

/** Registry de todas as chains suportadas. */
export const CHAINS: Record<number, ChainConfig> = {
  [BASE_MAINNET.chainId]: BASE_MAINNET,
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
  [ARBITRUM_MAINNET.chainId]: ARBITRUM_MAINNET,
  [ARBITRUM_SEPOLIA.chainId]: ARBITRUM_SEPOLIA,
  [OPTIMISM_MAINNET.chainId]: OPTIMISM_MAINNET,
  [OPTIMISM_SEPOLIA.chainId]: OPTIMISM_SEPOLIA,
};

/** Helper para resolver config por chainId */
export function getChainConfig(chainId: number): ChainConfig {
  const config = CHAINS[chainId];
  if (!config) {
    throw new Error(`ChainConfig not found for chainId=${chainId}`);
  }
  return config;
}
