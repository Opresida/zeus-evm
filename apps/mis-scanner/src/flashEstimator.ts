/**
 * Estimador de flash-arb — quando o MIS acha divergência persistente, traduz a
 * oportunidade em NÚMEROS REAIS de execução via quoter on-chain (impacto incluído).
 *
 * O spot local diz "tem divergência"; o quoter diz "quanto sobra DEPOIS do impacto
 * de preço + fee + premium do flashloan + gas". Só o quoter responde se é lucro
 * real — divergência de spot sem checar impacto engana (pool raso come o edge).
 *
 * Round-trip: empresta tokenB (Aave) → compra tokenA no pool BARATO → vende tokenA
 * no pool CARO → devolve tokenB + premium 0.05%. Lucro = sobra após devolução e gas.
 *
 * Roda SÓ pros grupos com divergência ativa (não em todo scan) — economiza RPC.
 */

import type { Address, PublicClient } from 'viem';
import { formatUnits, parseUnits } from 'viem';
import { quoteUniswapV3, quoteAerodrome, quoteTraderJoe, quoteUniswapV2, quoteSlipstream, isQuote } from '@zeus-evm/dex-adapters';
import type { PoolGroup, InefficiencyObservation } from '@zeus-evm/execution-utils';
import type { ChainConfig } from '@zeus-evm/chain-config';

type AnyPublicClient = PublicClient<any, any>;

/** Aave V3 flashloan premium: 0.05% = 5 bps. */
const AAVE_FLASH_PREMIUM_BPS = 5n;
/** Gas estimado de um flash-arb (flashloan callback + 2 swaps + transfers). */
const DEFAULT_FLASH_GAS_UNITS = 350_000n;

const STABLE_SYMBOLS = new Set(['USDC', 'USDBC', 'USDT', 'DAI', 'USDC.E', 'USDS', 'GHO']);

export interface FlashArbEstimate {
  pair: string;
  timestamp: number;
  isoTime: string;
  cheapPool: string;
  expensivePool: string;
  divergenceBps: number;
  /** Valor do empréstimo (flashloan) em tokenB. */
  loanTokenB: string;
  loanUsd: number;
  /** Valor de devolução à Aave (empréstimo + premium 0.05%). */
  repayTokenB: string;
  repayUsd: number;
  gasCostUsd: number;
  grossProfitUsd: number;
  netProfitUsd: number;
  /** Lucro líquido em % sobre o empréstimo. */
  profitPct: number;
  profitable: boolean;
  /** Quanto do empréstimo volta no round-trip (1.0 = ileso). < 1 = slippage+fee. */
  roundTripRatio: number;
  /**
   * Pool suporta o notional? false = raso (slippage devora o trade — não dá pra
   * arbitrar nesse tamanho). Gate pra tirar lixo do ranking de persistência.
   */
  supportsNotional: boolean;
}

export interface FlashEstimatorOpts {
  /** Notional do flashloan em USD. Default 10_000. */
  notionalUsd?: number;
  /** Preço do ETH em USD (pra gas + tokenB=WETH). Default: cotado on-chain. */
  ethUsd?: number;
  /** Gas units do flash-arb. Default 350k. */
  gasUnits?: bigint;
  /**
   * Budget de slippage (bps) pro gate de profundidade. Se o round-trip do notional
   * voltar menos que (1 − budget), o pool é raso → supportsNotional=false. Default 500 (5%).
   */
  maxSlippageBps?: number;
  /** Gas price (wei) — passe pra evitar refetch numa varredura de tamanhos. */
  gasPriceWei?: bigint;
}

function splitPair(label: string): { aSym: string; bSym: string } {
  const [aSym = '?', bSym = '?'] = label.split('/');
  return { aSym, bSym };
}

/** Cota 1 perna do round-trip no pool indicado (UniV3 via QuoterV2, Aero via router). */
async function quoteLeg(args: {
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  ref: PoolGroup['pools'][number];
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  decimalsIn: number;
  decimalsOut: number;
}): Promise<bigint | null> {
  const { client, chainConfig, ref, tokenIn, tokenOut, amountIn, decimalsIn, decimalsOut } = args;
  if (ref.dex === 'univ3') {
    // Forks (Pancake/Sushi) carregam o próprio quoter no ref; UniV3 canônico usa o do config.
    const q = await quoteUniswapV3({
      client,
      quoterAddress: ref.quoter ?? chainConfig.uniswapV3.quoterV2,
      tokenIn,
      tokenOut,
      amountIn,
      fee: ref.fee ?? 500,
      decimalsIn,
      decimalsOut,
    });
    return isQuote(q) ? q.amountOut : null;
  }
  if (ref.dex === 'slipstream') {
    if (!chainConfig.slipstream || ref.tickSpacing === undefined) return null;
    const q = await quoteSlipstream({
      client,
      quoterAddress: ref.quoter ?? chainConfig.slipstream.quoter,
      swapRouter: ref.router ?? chainConfig.slipstream.swapRouter,
      tokenIn,
      tokenOut,
      amountIn,
      tickSpacing: ref.tickSpacing,
      decimalsIn,
      decimalsOut,
    });
    return isQuote(q) ? q.amountOut : null;
  }
  if (ref.dex === 'univ2') {
    if (!ref.router) return null;
    const q = await quoteUniswapV2({
      client,
      routerAddress: ref.router,
      venue: ref.venue,
      tokenIn,
      tokenOut,
      amountIn,
      decimalsIn,
      decimalsOut,
    });
    return isQuote(q) ? q.amountOut : null;
  }
  if (ref.dex === 'traderjoe') {
    // swapForY = entra tokenX. Quote exato via getSwapOut (view) no LBPair.
    const swapForY = (ref.lbTokenX ?? '').toLowerCase() === tokenIn.toLowerCase();
    const q = await quoteTraderJoe({ client, pair: ref.pool, amountIn, swapForY });
    return q && q.amountOut > 0n ? q.amountOut : null;
  }
  if (!chainConfig.aerodrome) return null;
  const q = await quoteAerodrome({
    client,
    routerAddress: chainConfig.aerodrome.router,
    factoryAddress: chainConfig.aerodrome.factory,
    tokenIn,
    tokenOut,
    amountIn,
    stable: ref.stable ?? false,
    decimalsIn,
    decimalsOut,
  });
  return isQuote(q) ? q.amountOut : null;
}

/**
 * Preço USD de 1 unidade de um token QUALQUER (genérico, pra sizing da execução).
 * USDC → 1; senão cota `token → USDC` via UniV3 (fee 500 e 3000, pega o melhor). 0 se não cotar.
 * NÃO usa lista fixa de preço — descobre on-chain.
 */
export async function fetchTokenUsd(
  client: AnyPublicClient,
  chainConfig: ChainConfig,
  token: Address,
  decimals: number,
): Promise<number> {
  const usdc = chainConfig.tokens['USDC'] as Address | undefined;
  if (!usdc) return 0;
  if (token.toLowerCase() === usdc.toLowerCase()) return 1;
  let best = 0;
  for (const fee of [500, 3000, 100, 10000]) {
    try {
      const q = await quoteUniswapV3({
        client,
        quoterAddress: chainConfig.uniswapV3.quoterV2,
        tokenIn: token,
        tokenOut: usdc,
        amountIn: parseUnits('1', decimals),
        fee,
        decimalsIn: decimals,
        decimalsOut: 6,
      });
      if (isQuote(q)) {
        const px = Number(formatUnits(q.amountOut, 6));
        if (px > best) best = px;
      }
    } catch {
      /* fee tier sem pool — tenta o próximo */
    }
  }
  return best;
}

/** Cota ~1 WETH → USDC pra obter o preço do ETH em USD (gas + conversões). */
export async function fetchEthUsd(client: AnyPublicClient, chainConfig: ChainConfig): Promise<number> {
  const weth = chainConfig.tokens['WETH'] as Address | undefined;
  const usdc = chainConfig.tokens['USDC'] as Address | undefined;
  if (!weth || !usdc) return 0;
  const q = await quoteUniswapV3({
    client,
    quoterAddress: chainConfig.uniswapV3.quoterV2,
    tokenIn: weth,
    tokenOut: usdc,
    amountIn: parseUnits('1', 18),
    fee: 500,
    decimalsIn: 18,
    decimalsOut: 6,
  });
  return isQuote(q) ? Number(formatUnits(q.amountOut, 6)) : 0;
}

/**
 * Estima o flash-arb de um grupo com divergência ativa. Faz 2 quotes (buy+sell).
 * Retorna null se faltar pool/quote (ex: pool sumiu, sem liquidez pro notional).
 */
export async function estimateFlashArb(args: {
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  group: PoolGroup;
  observation: InefficiencyObservation;
  opts?: FlashEstimatorOpts;
}): Promise<FlashArbEstimate | null> {
  const { client, chainConfig, group, observation, opts = {} } = args;
  if (!observation.cheapPool || !observation.expensivePool) return null;

  const cheapRef = group.pools.find((p) => p.label === observation.cheapPool);
  const expRef = group.pools.find((p) => p.label === observation.expensivePool);
  if (!cheapRef || !expRef) return null;

  const notionalUsd = opts.notionalUsd ?? 10_000;
  const ethUsd = opts.ethUsd ?? (await fetchEthUsd(client, chainConfig));
  const gasUnits = opts.gasUnits ?? DEFAULT_FLASH_GAS_UNITS;

  // H4: sem preço de ETH confiável (quote falhou → 0/NaN) NÃO dá pra precificar gás. Emitir um
  // "lucro" com gás $0 contaminaria o ledger do DRY_RUN. Melhor pular esta observação.
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) return null;

  const { bSym } = splitPair(group.label);
  // Preço de tokenB (quote) em USD: stable→1, WETH→ethUsd. Token que não é stable nem WETH NÃO tem
  // preço confiável aqui (antes caía pra ethUsd, mispricing) → pula (mantém o ledger honesto).
  const bUpper = bSym.toUpperCase();
  const bUsd = STABLE_SYMBOLS.has(bUpper) ? 1 : bUpper === 'WETH' ? ethUsd : 0;
  if (bUsd <= 0) return null;

  // Notional em tokenB (wei)
  const loanTokenB = parseUnits((notionalUsd / bUsd).toFixed(group.decimalsB), group.decimalsB);
  if (loanTokenB <= 0n) return null;

  // Perna 1: compra tokenA no pool BARATO (paga tokenB, recebe tokenA)
  const amountA = await quoteLeg({
    client, chainConfig, ref: cheapRef,
    tokenIn: group.tokenB, tokenOut: group.tokenA,
    amountIn: loanTokenB, decimalsIn: group.decimalsB, decimalsOut: group.decimalsA,
  });
  if (!amountA || amountA <= 0n) return null;

  // Perna 2: vende tokenA no pool CARO (paga tokenA, recebe tokenB)
  const amountBOut = await quoteLeg({
    client, chainConfig, ref: expRef,
    tokenIn: group.tokenA, tokenOut: group.tokenB,
    amountIn: amountA, decimalsIn: group.decimalsA, decimalsOut: group.decimalsB,
  });
  if (!amountBOut || amountBOut <= 0n) return null;

  // Economia
  const premium = (loanTokenB * AAVE_FLASH_PREMIUM_BPS) / 10_000n;
  const repayTokenB = loanTokenB + premium;
  const grossProfitTokenB = amountBOut - loanTokenB; // antes de premium + gas
  const netBeforeGasTokenB = amountBOut - repayTokenB;

  const grossProfitUsd = Number(formatUnits(grossProfitTokenB, group.decimalsB)) * bUsd;
  const gasPriceWei = opts.gasPriceWei ?? (await client.getGasPrice());
  const gasCostEth = Number(formatUnits(gasUnits * gasPriceWei, 18));
  const gasCostUsd = gasCostEth * ethUsd;
  const netProfitUsd = Number(formatUnits(netBeforeGasTokenB, group.decimalsB)) * bUsd - gasCostUsd;

  // Gate de profundidade: quanto do empréstimo sobrevive ao round-trip?
  const loanNum = Number(formatUnits(loanTokenB, group.decimalsB));
  const outNum = Number(formatUnits(amountBOut, group.decimalsB));
  const roundTripRatio = loanNum > 0 ? outNum / loanNum : 0;
  const maxSlippageBps = opts.maxSlippageBps ?? 500;
  const supportsNotional = roundTripRatio >= 1 - maxSlippageBps / 10_000;

  return {
    pair: group.label,
    timestamp: observation.timestamp,
    isoTime: new Date(observation.timestamp).toISOString(),
    cheapPool: observation.cheapPool,
    expensivePool: observation.expensivePool,
    divergenceBps: observation.maxDivergenceBps,
    loanTokenB: `${formatUnits(loanTokenB, group.decimalsB)} ${bSym}`,
    loanUsd: notionalUsd,
    repayTokenB: `${formatUnits(repayTokenB, group.decimalsB)} ${bSym}`,
    repayUsd: Number(formatUnits(repayTokenB, group.decimalsB)) * bUsd,
    gasCostUsd: Math.round(gasCostUsd * 100) / 100,
    grossProfitUsd: Math.round(grossProfitUsd * 100) / 100,
    netProfitUsd: Math.round(netProfitUsd * 100) / 100,
    profitPct: Math.round((netProfitUsd / notionalUsd) * 10_000) / 100,
    profitable: netProfitUsd > 0,
    roundTripRatio: Math.round(roundTripRatio * 10_000) / 10_000,
    supportsNotional,
  };
}

/** Candidatos de notional (USD) em escala ~logarítmica — varredura padrão. */
const DEFAULT_LOAN_CANDIDATES = [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000];

export interface FlashOptimization {
  pair: string;
  /** Estimativa no tamanho de MAIOR lucro líquido (pico da curva). null = nenhum lucra. */
  best: FlashArbEstimate | null;
  /** Maior empréstimo (USD) que ainda fecha com lucro líquido > 0. 0 = nenhum viável. */
  maxViableLoanUsd: number;
  /** Curva lucro × tamanho (pra inspeção/log). */
  curve: Array<{ loanUsd: number; netProfitUsd: number; roundTripRatio: number; profitable: boolean }>;
}

export interface OptimizeOpts {
  /** Lista de notionais (USD) a testar. Default escala log 1k→250k. */
  candidatesUsd?: number[];
  ethUsd?: number;
  gasUnits?: bigint;
  maxSlippageBps?: number;
}

/**
 * Acha o TAMANHO ÓTIMO do flashloan: o maior que ainda vale a pena antes do
 * slippage matar o edge. O lucro × tamanho é côncavo (sobe com a divergência,
 * cai quando o impacto domina) — varremos candidatos crescentes via quoter e
 * paramos cedo quando passamos do pico (poupa RPC).
 *
 * Cota ethUsd + gasPrice 1x e reusa em todos os tamanhos. Só rode em divergência ativa.
 */
export async function optimizeFlashLoan(args: {
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  group: PoolGroup;
  observation: InefficiencyObservation;
  opts?: OptimizeOpts;
}): Promise<FlashOptimization> {
  const { client, chainConfig, group, observation, opts = {} } = args;
  const candidates = (opts.candidatesUsd ?? DEFAULT_LOAN_CANDIDATES).slice().sort((a, b) => a - b);

  // Cota preço do ETH + gas 1x pra reusar na varredura inteira
  const ethUsd = opts.ethUsd ?? (await fetchEthUsd(client, chainConfig));
  const gasPriceWei = await client.getGasPrice();

  const curve: FlashOptimization['curve'] = [];
  let best: FlashArbEstimate | null = null;
  let maxViableLoanUsd = 0;
  let sawProfit = false;

  for (const loanUsd of candidates) {
    const est = await estimateFlashArb({
      client, chainConfig, group, observation,
      opts: { notionalUsd: loanUsd, ethUsd, gasUnits: opts.gasUnits, maxSlippageBps: opts.maxSlippageBps, gasPriceWei },
    });
    if (!est) break; // pool sumiu / sem quote — não adianta ir maior

    curve.push({ loanUsd, netProfitUsd: est.netProfitUsd, roundTripRatio: est.roundTripRatio, profitable: est.profitable });

    if (est.netProfitUsd > 0) {
      sawProfit = true;
      maxViableLoanUsd = loanUsd;
    }
    if (!best || est.netProfitUsd > best.netProfitUsd) best = est;

    // Early-stop: já vimos lucro e agora ficou negativo → passamos do pico, maiores só pioram
    if (sawProfit && est.netProfitUsd <= 0) break;
    // Pool raso já no menor tamanho (impacto catastrófico) → não vale escalar
    if (!sawProfit && est.roundTripRatio < 0.5) break;
  }

  // best só conta se realmente lucra; senão null (nada viável)
  if (best && best.netProfitUsd <= 0) best = null;

  return { pair: group.label, best, maxViableLoanUsd, curve };
}
