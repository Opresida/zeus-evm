/**
 * Motor 2 / Filler UniswapX — metadata dos tokens valoráveis da Base (símbolo + decimais).
 *
 * v1 só preenche ordens cujo token de SAÍDA é valorável (estimateUsd resolve). Este mapa cobre os
 * blue-chips/stables onde a margem foi medida; tokens fora dele → ordem descartada (conservador).
 */

import type { Address } from 'viem';

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

const META: Record<string, TokenMeta> = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': { symbol: 'EURC', decimals: 6 },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8 },
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH', decimals: 18 },
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { symbol: 'wstETH', decimals: 18 },
  '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c': { symbol: 'rETH', decimals: 18 },
};

export function baseTokenMeta(token: Address): TokenMeta | undefined {
  return META[token.toLowerCase()];
}
