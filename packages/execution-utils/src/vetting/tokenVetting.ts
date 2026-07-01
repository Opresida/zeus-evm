/**
 * TokenVettingService — o "porteiro" de tokens, compartilhado pelos 2 motores.
 *
 * Compõe SÓ infra existente: safety (GoPlus/CoinGecko realocado aqui) + rota de saída multi-DEX
 * (`bestSwapAcrossDexes`) + piso de liquidez. Emite um verdict por motor (a POLÍTICA difere por motor —
 * ver ./policy). NÃO toca contrato — 100% off-chain.
 *
 * Etapa 1 (light): lock = flag do GoPlus; liquidez = cotação viável em tamanho realista. A leitura on-chain
 * do contrato de lock + o round-trip de profundidade entram na Etapa 6 (deep).
 */

import type { Address, PublicClient } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

import { bestSwapAcrossDexes } from '@zeus-evm/dex-adapters';
import { fetchTokenSafety, type TokenSafety } from './tokenSafety';
import { applyTokenSafetyFilters } from './tokenSafetyFilters';
import { applyPolicy, type VettingMotor } from './policy';
import { buildReasons } from './reasons';

export type { VettingMotor } from './policy';

export interface TokenVerdict {
  token: string;
  symbol: string;
  motor: VettingMotor;
  verdict: 'pass' | 'reject';
  reasons: string[];
  checks: {
    safety: { ok: boolean; detail?: string };
    exitRoute: { ok: boolean; dex?: string };
    liquidityFloor: { ok: boolean; usd: number };
    lockStatus: { ok: boolean; locked: boolean; source: 'goplus' | 'onchain' };
  };
  /** Dado incompleto (safety indisponível / fonte falhou). Usado pelo fail-safe do M1 (parcial → não bloqueia). */
  partial: boolean;
  atIso: string;
}

export interface VetTokenOpts {
  motor: VettingMotor;
  token: Address;
  symbol: string;
  decimals: number;
  chainConfig: ChainConfig;
  client: PublicClient<any, any>;
  /** Token estável de referência pra testar a saída (ex: USDC). */
  quoteToken: Address;
  quoteTokenDecimals: number;
  /** Notional (em wei do token) pra cotar a saída — caller calcula pra ~$1k (NUNCA 1 unidade). */
  exitNotionalWei: bigint;
  /** Piso de liquidez exigido em USD (default 50k). */
  liquidityFloorUsd?: number;
  /** Blocklist de tokens sem-edge (NO_EDGE), lowercased. Só aplica pro motor2. */
  noEdgeBlocklist?: ReadonlySet<string>;
  /** ISO de "agora" injetável (testes determinísticos). */
  nowIso?: string;
  logger?: LoggerLike;
}

/** Deps injetáveis (testes substituem rede/cotação). */
export interface VetTokenDeps {
  fetchSafety?: (chainId: number, addresses: string[], logger?: LoggerLike) => Promise<TokenSafety[]>;
  bestSwap?: typeof bestSwapAcrossDexes;
}

const defaultFetchSafety: NonNullable<VetTokenDeps['fetchSafety']> = (chainId, addresses, logger) =>
  fetchTokenSafety({ chainId, addresses, logger });

/**
 * Veta um token pro motor dado. Retorna o verdict completo (pass/reject + motivos PT-BR + 4 checks).
 * Fail-safe é responsabilidade do CALLER (Etapa 3/5): dado parcial → motor1 trata como pass, motor2 como reject.
 */
export async function vetToken(opts: VetTokenOpts, deps: VetTokenDeps = {}): Promise<TokenVerdict> {
  const fetchSafety = deps.fetchSafety ?? defaultFetchSafety;
  const bestSwap = deps.bestSwap ?? bestSwapAcrossDexes;
  const floorUsd = opts.liquidityFloorUsd ?? 50_000;
  const chainId = opts.chainConfig.chainId;
  const tokenLc = opts.token.toLowerCase();

  // 1) Segurança (GoPlus/CoinGecko, cache 24h).
  let safety: TokenSafety | undefined;
  try {
    const res = await fetchSafety(chainId, [opts.token], opts.logger);
    safety = res[0];
  } catch (err) {
    opts.logger?.warn?.({ token: opts.token, err: String(err) }, 'vetting: fetchSafety falhou (parcial)');
  }
  const safetyResult = safety ? applyTokenSafetyFilters(safety) : { passed: false, reason: 'sem dados de segurança' };
  const isHoneypot = safety?.isHoneypot ?? false;
  const locked = safety?.topHolderIsLocked ?? false;

  // 2) Rota de saída multi-DEX (token → quoteToken) em tamanho realista.
  let exitOk = false;
  let exitDex: string | undefined;
  let outUsd = 0;
  try {
    const quote = await bestSwap({
      client: opts.client,
      chainConfig: opts.chainConfig,
      tokenIn: opts.token,
      tokenOut: opts.quoteToken,
      amountIn: opts.exitNotionalWei,
      decimalsIn: opts.decimals,
      decimalsOut: opts.quoteTokenDecimals,
    });
    if (quote) {
      exitOk = true;
      exitDex = quote.source;
      // amountOut em unidades do quoteToken (USDC≈USD) — proxy de "consegue vender o notional".
      outUsd = Number(quote.amountOut) / 10 ** opts.quoteTokenDecimals;
    }
  } catch (err) {
    opts.logger?.warn?.({ token: opts.token, err: String(err) }, 'vetting: bestSwap falhou (parcial)');
  }

  // 3) Piso de liquidez (Etapa 1 light): cotação viável no notional = consegue vender esse tamanho.
  //    `floorUsd` fica registrado pro caller/Etapa 6 endurecer com profundidade real (round-trip + pool depth).
  void floorUsd;
  const liquidityOk = exitOk && outUsd > 0;
  const liquidityUsd = exitOk ? Math.max(outUsd, 0) : 0;

  const result = applyPolicy(opts.motor, {
    safetyOk: safetyResult.passed,
    exitRouteOk: exitOk,
    liquidityFloorOk: liquidityOk,
    isHoneypot,
    noEdge: opts.noEdgeBlocklist?.has(tokenLc) ?? false,
  });

  const reasons = buildReasons(result, { motor: opts.motor, exitDex, liquidityUsd, locked });

  return {
    token: opts.token,
    symbol: opts.symbol,
    motor: opts.motor,
    verdict: result.verdict,
    reasons,
    checks: {
      safety: { ok: safetyResult.passed, detail: safetyResult.reason },
      exitRoute: { ok: exitOk, dex: exitDex },
      liquidityFloor: { ok: liquidityOk, usd: liquidityUsd },
      lockStatus: { ok: true, locked, source: 'goplus' },
    },
    partial: !safety || !!safety.partial,
    atIso: opts.nowIso ?? new Date().toISOString(),
  };
}
