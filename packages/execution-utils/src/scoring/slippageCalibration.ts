/**
 * #5 automação — CALIBRAÇÃO DE SLIPPAGE POR DEX (seed do Dune).
 *
 * Hoje o gate de slippage é GLOBAL (um `MAX_SLIPPAGE_BPS` pra todos os DEXes). Mas o slippage/impacto
 * REAL varia MUITO por DEX (medido no Dune): Aerodrome Slipstream ~64-107 bps, UniV3 ~90-127, Aerodrome
 * volátil ~147-255. Um valor único é apertado demais num e generoso demais noutro.
 *
 * Aqui: a tolerância de slippage por DEX × faixa de tamanho, semeada do p95 REAL do histórico da Base
 * (Dune query 7860473, 30d, 2026-07-01). `slippageBpsFor(dex, notionalUsd)` devolve o p95 daquele DEX/tamanho.
 * Pra uma rota de arb (compra num DEX, vende noutro), a tolerância = soma das duas pernas.
 *
 * ⚠️ Métrica é PROXY (desvio da mediana horária no Dune) — inclui ruído/MEV. Boa pra comparar DEXes e
 * calibrar um chute inicial defensável; refinar depois (impacto por reservas). Observe-first: o bot mostra
 * o que a calibração FARIA e só injeta quando ligada.
 */

/** Faixas de tamanho (USD) — espelham os buckets da query Dune. */
export type SizeBucket = 0 | 1 | 2 | 3 | 4; // ≤1k, 1-5k, 5-25k, 25-100k, >100k

/** p95 do slippage (bps) por DEX × bucket. Seed do Dune (7860473); valores capados quando a amostra é pequena. */
const SLIPPAGE_P95_BPS: Record<string, readonly [number, number, number, number, number]> = {
  'aerodrome-slipstream': [73, 64, 68, 107, 200], // 5.7M trades — dado sólido; >100k real 301 → capa 200
  'pancake-v3':           [80, 75, 87, 86, 160],
  'uniswap-v3':           [95, 91, 120, 127, 146],
  'uniswap-v4':           [71, 78, 99, 130, 130], // 25-100k real 264 (amostra pequena) → capa 130
  'aerodrome-volatile':   [147, 167, 230, 255, 300],
  'alienbase':            [84, 98, 90, 120, 150], // amostra pequena → conservador
  'uniswap-v2':           [128, 175, 200, 220, 250], // forks V2 genéricos → conservador
};

/** DEX desconhecido → conservador (não deixa passar trade arriscado só por não estar no mapa). */
const DEFAULT_P95: readonly [number, number, number, number, number] = [120, 130, 160, 200, 250];

/** Data/fonte do seed — pra o painel/logs mostrarem a proveniência. */
export const SLIPPAGE_CALIBRATION_SOURCE = 'Dune 7860473 · Base 30d · 2026-07-01';

export function sizeBucketFor(notionalUsd: number): SizeBucket {
  if (notionalUsd < 1000) return 0;
  if (notionalUsd < 5000) return 1;
  if (notionalUsd < 25000) return 2;
  if (notionalUsd < 100000) return 3;
  return 4;
}

/** Normaliza um rótulo de DEX (ex.: "Aerodrome volatile", "UniV3 0.3%", "Slipstream") → chave do mapa. */
export function normalizeDexKey(label: string): keyof typeof SLIPPAGE_P95_BPS | 'unknown' {
  const s = label.toLowerCase();
  if (s.includes('slipstream') || (s.includes('aero') && s.includes('cl'))) return 'aerodrome-slipstream';
  if (s.includes('aero')) return 'aerodrome-volatile';
  if (s.includes('pancake')) return 'pancake-v3';
  if (s.includes('alien')) return 'alienbase';
  if (s.includes('v4') || s.includes(' 4')) return 'uniswap-v4';
  if (s.includes('univ3') || s.includes('uni v3') || s.includes('uniswap v3') || (s.includes('uni') && s.includes('v3'))) return 'uniswap-v3';
  // forks V2 genéricos (baseswap/swapbased/sushi/univ2) → conservador do V2
  if (s.includes('baseswap') || s.includes('swapbased') || s.includes('sushi') || s.includes('v2')) return 'uniswap-v2';
  // fallback: se menciona "uni" sem versão, assume V3 (o mais comum)
  if (s.includes('uni')) return 'uniswap-v3';
  return 'unknown';
}

/** p95 de slippage (bps) tolerável pra um DEX num dado tamanho de trade. */
export function slippageBpsFor(dexLabel: string, notionalUsd: number): number {
  const key = normalizeDexKey(dexLabel);
  const bucket = sizeBucketFor(notionalUsd);
  const row = key === 'unknown' ? DEFAULT_P95 : SLIPPAGE_P95_BPS[key];
  return row[bucket];
}

/**
 * Tolerância de slippage (bps) pra uma ROTA de arb: compra num DEX, vende noutro → soma das pernas.
 * É o valor que substitui o `MAX_SLIPPAGE_BPS` global quando a calibração está ligada.
 */
export function routeSlippageBps(buyDex: string, sellDex: string, notionalUsd: number): number {
  return slippageBpsFor(buyDex, notionalUsd) + slippageBpsFor(sellDex, notionalUsd);
}

/**
 * Gate compartilhado (M1+M2): a tolerância de slippage EFETIVA (bps). Observe-first: com `perDexEnabled=false`
 * (default) devolve o GLOBAL (comportamento de sempre — sem regressão); com `true` devolve o per-DEX (seed Dune).
 * `legs=1` (venda de colateral do M1) ou `legs=2` (round-trip do arb M2). `notionalUsd` padrão 10k se desconhecido.
 */
export function effectiveMaxSlippageBps(opts: {
  dexLabel: string;
  globalBps: number;
  perDexEnabled: boolean;
  notionalUsd?: number;
  secondDexLabel?: string; // se presente → rota de 2 pernas (arb)
}): number {
  if (!opts.perDexEnabled) return opts.globalBps;
  const n = opts.notionalUsd && opts.notionalUsd > 0 ? opts.notionalUsd : 10_000;
  return opts.secondDexLabel
    ? routeSlippageBps(opts.dexLabel, opts.secondDexLabel, n)
    : slippageBpsFor(opts.dexLabel, n);
}
