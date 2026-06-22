/**
 * Utilities pra converter wei → amount humano + estimativa USD.
 *
 * Pra MVP: stable peg ≈ $1 pra tokens conhecidos (USDC/USDT/DAI/RLUSD/FRAX).
 * Pra WETH/ETH: usa ETH_USD_PRICE_ESTIMATE do config.
 * Pra tokens desconhecidos: retorna undefined (não inventa preço).
 *
 * TODO produção: substituir hardcoded por leitura de Chainlink oracle on-chain
 * (cached por bloco). Pra primeira semana DRY_RUN, hardcoded dá ordem de grandeza.
 */

/** Stables com peg ~ $1 (qualquer chain). Lowercased pra match insensitive. */
const STABLE_SYMBOLS = new Set([
  'usdc', 'usdc.e', 'usdce',
  'usdt', 'usdt0',
  'dai',
  'frax',
  'rlusd',
  'usdtb',
  'usd+',
  'lusd',
  'crvusd',
  'pyusd',
]);

/** ETH-pegged tokens — usa ETH_USD_PRICE pra avaliar. */
const ETH_SYMBOLS = new Set([
  'eth', 'weth',
  'wsteth',     // ~1.06× ETH no momento (simplificação MVP)
  'reth',       // ~1.10× ETH
  'cbeth',      // ~1.05× ETH
  'wbeth',
  'sweth',
  'ezeth',
  'rsweth',
  'eeth', 'weeth',
]);

/** BTC-pegged tokens — usa multiplier ~21× ETH como aproximação MVP grosseira. */
const BTC_SYMBOLS = new Set([
  'wbtc', 'cbbtc', 'tbtc',
]);

/**
 * Formata wei → string decimal humano (ex: 12450000n + 6 dec → "12.45").
 * Trunca pra 4 casas decimais visíveis (suficiente pra leitura de log).
 */
export function formatWei(wei: bigint, decimals: number, maxFracDigits = 4): string {
  if (decimals === 0) return wei.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = wei / divisor;
  const fraction = wei % divisor;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, maxFracDigits);
  // Remove trailing zeros pra leitura limpa
  const trimmed = fractionStr.replace(/0+$/, '');
  return trimmed === '' ? whole.toString() : `${whole}.${trimmed}`;
}

/**
 * Estima USD de um amount em wei pra um asset conhecido.
 * Retorna `undefined` se o asset não é stable, ETH-like ou BTC-like.
 *
 * @param ethUsdPrice preço ETH/USD estimado (do config, hardcoded MVP)
 */
export function estimateUsd(
  symbol: string | undefined,
  wei: bigint,
  decimals: number,
  ethUsdPrice: number,
): number | undefined {
  if (!symbol) return undefined;
  const sym = symbol.toLowerCase();

  // Stable peg
  if (STABLE_SYMBOLS.has(sym)) {
    return Number(wei) / 10 ** decimals; // valor em stable ≈ USD
  }

  // ETH family
  if (ETH_SYMBOLS.has(sym)) {
    const amount = Number(wei) / 10 ** decimals;
    return amount * ethUsdPrice;
  }

  // BTC family — usa ~21× ETH como proxy (refinar via oracle depois)
  if (BTC_SYMBOLS.has(sym)) {
    const amount = Number(wei) / 10 ** decimals;
    return amount * ethUsdPrice * 21;
  }

  return undefined;
}

/**
 * Calcula custo de gas em USD a partir do receipt + ethUsdPrice.
 * gasUsed (units) × effectiveGasPrice (wei/unit) = ETH wei → ×ethUsdPrice = USD.
 */
export function gasCostUsd(
  gasUsed: bigint,
  effectiveGasPrice: bigint,
  ethUsdPrice: number,
): number {
  const gasCostWei = gasUsed * effectiveGasPrice;
  const gasCostEth = Number(gasCostWei) / 1e18;
  return gasCostEth * ethUsdPrice;
}

/**
 * Priority fee REAL por gas (wei) = effectiveGasPrice − baseFeePerGas (clampado em ≥ 0).
 * Antes passávamos o `effectiveGasPrice` cheio como "priority fee", o que superestimava o custo de
 * inclusão numa L2 onde a baseFee domina. Retorna `undefined` quando falta algum dado (o reconciler
 * então simplesmente não calcula o sub-métrico de inclusão).
 */
export function realizedPriorityFeeWei(
  effectiveGasPrice: bigint | null | undefined,
  baseFeePerGas: bigint | null | undefined,
): bigint | undefined {
  if (effectiveGasPrice == null || baseFeePerGas == null) return undefined;
  return effectiveGasPrice > baseFeePerGas ? effectiveGasPrice - baseFeePerGas : 0n;
}
