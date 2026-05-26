export type { ChainConfig } from './types';
export { BASE_MAINNET } from './base';
export { BASE_SEPOLIA } from './base-sepolia';
export { ARBITRUM_MAINNET } from './arbitrum';
export { ARBITRUM_SEPOLIA } from './arbitrum-sepolia';
export { OPTIMISM_MAINNET } from './optimism';
export { OPTIMISM_SEPOLIA } from './optimism-sepolia';
export { BASE_TARGET_PAIRS, findPairById } from './target-pairs';
export type { TargetPair } from './target-pairs';
export { OPTIMISM_TARGET_PAIRS, findOptimismPairById } from './target-pairs-optimism';

import { BASE_TARGET_PAIRS } from './target-pairs';
import { OPTIMISM_TARGET_PAIRS } from './target-pairs-optimism';
import type { TargetPair } from './target-pairs';

/**
 * Resolve target pairs por chain. Centraliza decisão "qual lista usar"
 * pra que apps (backrun-engine) fiquem agnósticos de qual chain ativaram.
 *
 * Quando scraper auto-update estiver ativo (Fase 3), esse resolver vai
 * preferir lista dinâmica (.json gerado pelo scraper) SE existir,
 * senão cai pra lista hardcoded por chain.
 */
export function getTargetPairsForChain(chainId: number): readonly TargetPair[] {
  switch (chainId) {
    case 8453: return BASE_TARGET_PAIRS;
    case 10: return OPTIMISM_TARGET_PAIRS;
    default: return [];
  }
}

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
