/**
 * Porteiro de tokens — Motor 2 em modo OBSERVAR (Etapa 2).
 *
 * Veta os tokens do universo do MIS (os 2 tokens de cada PoolGroup), registra o verdict no
 * VettingUniverseTracker e EMITE token.entered/token.exited quando o verdict MUDA. NÃO filtra nada
 * (observar) — o filtro de verdade (enforce) é a Etapa 3, atrás do botão admin.
 *
 * Sizing da saída (Etapa 2): cota 1 token (parseUnits('1', decimals)) só pra confirmar que existe rota
 * de venda numa DEX. A profundidade real (round-trip) entra na Etapa 6.
 */

import { type Address, type PublicClient, parseUnits } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';
import {
  vetToken,
  initCache,
  VettingUniverseTracker,
  type EventBus,
  type PoolGroup,
} from '@zeus-evm/execution-utils';

type AnyPublicClient = PublicClient<any, any>;
type LoggerLike = { info: (...args: any[]) => void; warn: (...args: any[]) => void };

export interface VettingObserveOpts {
  groups: PoolGroup[];
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  quoteToken: Address;
  quoteTokenDecimals: number;
  eventBus: EventBus;
  tracker: VettingUniverseTracker;
  mode: 'dryrun' | 'testnet' | 'mainnet';
  safetyCacheDir: string;
  logger: LoggerLike;
  /** Blocklist sem-edge (NO_EDGE) — vazio por ora (universo já é edge-curado; gate vale p/ auto-promoção). */
  noEdgeBlocklist?: ReadonlySet<string>;
}

/** Coleta os tokens distintos do universo (pula o quoteToken — não dá pra cotar USDC→USDC). */
function distinctTokens(groups: PoolGroup[], quoteToken: Address) {
  const out = new Map<string, { token: Address; symbol: string; decimals: number }>();
  const q = quoteToken.toLowerCase();
  for (const g of groups) {
    const [symA, symB] = (g.label || '/').split('/');
    for (const [token, symbol, decimals] of [
      [g.tokenA, symA, g.decimalsA] as const,
      [g.tokenB, symB, g.decimalsB] as const,
    ]) {
      const k = token.toLowerCase();
      if (k === q || out.has(k)) continue;
      out.set(k, { token, symbol: symbol || token.slice(0, 8), decimals });
    }
  }
  return [...out.values()];
}

/** Veta o universo do M2 e emite as transições (observar). Retorna quantos passaram/reprovaram. */
export async function runVettingObserve(opts: VettingObserveOpts): Promise<{ pass: number; reject: number }> {
  initCache(opts.safetyCacheDir);
  const tokens = distinctTokens(opts.groups, opts.quoteToken);
  opts.logger.info({ tokens: tokens.length }, '🛂 vetting (observar): vetando o universo do M2...');

  let pass = 0;
  let reject = 0;
  for (const t of tokens) {
    let verdict;
    try {
      verdict = await vetToken({
        motor: 'motor2',
        token: t.token,
        symbol: t.symbol,
        decimals: t.decimals,
        chainConfig: opts.chainConfig,
        client: opts.client,
        quoteToken: opts.quoteToken,
        quoteTokenDecimals: opts.quoteTokenDecimals,
        exitNotionalWei: parseUnits('1', t.decimals), // Etapa 2: rota-existe; profundidade real = Etapa 6
        noEdgeBlocklist: opts.noEdgeBlocklist,
      });
    } catch (err) {
      opts.logger.warn({ token: t.token, err: String(err) }, 'vetting: vetToken falhou (observar) — ignorado');
      continue;
    }

    if (verdict.verdict === 'pass') pass++;
    else reject++;

    const transition = opts.tracker.record(verdict);
    if (!transition) continue; // sem mudança → não emite (anti-flicker)

    // Emit isolado: observabilidade NUNCA pode derrubar o boot do scanner.
    try {
      opts.eventBus.emit({
        type: transition === 'entered' ? 'token.entered' : 'token.exited',
        timestamp: new Date().toISOString(),
        chain: opts.chainConfig.name,
        mode: opts.mode,
        severity: 'info',
        token: t.token,
        symbol: t.symbol,
        motor: 'motor2',
        pair: t.symbol,
        reason: verdict.reasons[0] ?? '',
        exitDex: verdict.checks.exitRoute.dex,
        liquidityUsd: verdict.checks.liquidityFloor.usd,
        locked: verdict.checks.lockStatus.locked,
        wouldEnforce: false,
      });
    } catch (err) {
      opts.logger.warn({ err: String(err) }, 'vetting: emit token.* falhou — ignorado');
    }
  }

  opts.logger.info({ pass, reject }, `🛂 vetting (observar): ${pass} entraram · ${reject} sairiam (só observando)`);
  return { pass, reject };
}
