export type { ChainConfig, AaveMarketConfig } from './types';
export { BASE_MAINNET } from './base';
export { BASE_SEPOLIA } from './base-sepolia';
export { ARBITRUM_MAINNET } from './arbitrum';
export { ARBITRUM_SEPOLIA } from './arbitrum-sepolia';
export { OPTIMISM_MAINNET } from './optimism';
export { OPTIMISM_SEPOLIA } from './optimism-sepolia';
export { POLYGON_MAINNET } from './polygon';
export { BASE_TARGET_PAIRS, findPairById } from './target-pairs';
export type { TargetPair } from './target-pairs';
export { OPTIMISM_TARGET_PAIRS, findOptimismPairById } from './target-pairs-optimism';

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { BASE_TARGET_PAIRS } from './target-pairs';
import { OPTIMISM_TARGET_PAIRS } from './target-pairs-optimism';
import type { TargetPair } from './target-pairs';

/** Chain ID → identifier GeckoTerminal (mesmo schema do discovery-scraper). */
const CHAIN_TO_GECKO_NETWORK: Record<number, string> = {
  8453: 'base',
  10: 'optimism',
  42161: 'arbitrum',
  137: 'polygon_pos',
  43114: 'avax',
};

/**
 * Diretório onde scraper escreve auto-targets/<chain>.json. Pode ser sobrescrito
 * via env AUTO_TARGETS_DIR. Default: caminho relativo ao package raiz (resolved at runtime).
 */
function autoTargetsDir(): string {
  const fromEnv = process.env['AUTO_TARGETS_DIR'];
  if (fromEnv) return fromEnv;
  // Default: apps/backrun-engine/auto-targets relative ao CWD do app caller
  return resolvePath(process.cwd(), 'auto-targets');
}

/**
 * Carrega auto-targets do JSON gerado pelo scraper. Retorna [] se file ausente
 * ou corrompido — caller faz fallback pra hardcoded.
 */
function loadAutoTargets(chainId: number): TargetPair[] {
  const geckoNetwork = CHAIN_TO_GECKO_NETWORK[chainId];
  if (!geckoNetwork) return [];
  const path = resolvePath(autoTargetsDir(), `${geckoNetwork}.json`);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as {
      version?: number;
      targets?: Array<TargetPair & { scraperMeta?: unknown }>;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.targets)) return [];
    return parsed.targets;
  } catch {
    return [];
  }
}

/**
 * Resolve target pairs por chain. Estratégia:
 *   1. Carrega auto-targets/<chain>.json (gerado pelo scraper)
 *   2. Carrega lista hardcoded da chain (BASE_TARGET_PAIRS etc)
 *   3. MERGE: hardcoded TÊM prioridade — pares manualmente curados não são sobrescritos.
 *      Auto-targets só ADICIONAM o que não está na lista hardcoded.
 *
 * Quando scraper sugere par já presente na hardcoded, mantém versão hardcoded
 * (que pode ter ajustes manuais de decimals/USD-value mais precisos).
 */
export function getTargetPairsForChain(chainId: number): readonly TargetPair[] {
  let hardcoded: readonly TargetPair[] = [];
  switch (chainId) {
    case 8453: hardcoded = BASE_TARGET_PAIRS; break;
    case 10: hardcoded = OPTIMISM_TARGET_PAIRS; break;
    default: hardcoded = [];
  }

  const auto = loadAutoTargets(chainId);
  if (auto.length === 0) return hardcoded;

  const hardcodedIds = new Set(hardcoded.map((p) => p.id.toUpperCase()));
  const fromAuto = auto.filter((p) => !hardcodedIds.has(p.id.toUpperCase()));

  return [...hardcoded, ...fromAuto];
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
