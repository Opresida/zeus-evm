/**
 * Porteiro de tokens — Motor 1 (liquidação/pré-liq), modo OBSERVAR (Etapa 4).
 *
 * Política M1: o token é IMPOSTO (colateral do tomador) → a pergunta é "dá pra VENDER com segurança?"
 * (saída numa DEX + liquidez + não-honeypot). **SEM filtro de edge** (LSDs são aceitos — são o colateral da pré-liq).
 * Veta 1 colateral por vez, IDEMPOTENTE por token (só veta o que ainda não está no tracker — re-vet é a Etapa 6).
 * Emite token.entered/token.exited na transição. Observar NÃO filtra (nunca bloqueia a liquidação).
 *
 * Sizing da saída (Etapa 4): cota 1 token só pra confirmar rota; profundidade real (round-trip) = Etapa 6.
 */

import { parseUnits, type Address, type PublicClient } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';
import { vetToken, initCache, runRevetTick, type EventBus, type VettedEntry, type VettingUniverseTracker } from '@zeus-evm/execution-utils';
import type { PipelineDeps } from './pipeline';

/**
 * Extrai o colateral da position independentemente da convenção de nome do protocolo
 * (Aave usa collateralAsset*; Morpho/pré-liq usam collateralToken*; outros collateral*).
 */
function extractCollateral(p: Record<string, unknown>): { token: Address; symbol: string; decimals: number } | null {
  const token = (p.collateralAsset ?? p.collateralToken ?? p.collateralAddress) as Address | undefined;
  if (!token) return null;
  const symbol = String(p.collateralAssetSymbol ?? p.collateralTokenSymbol ?? p.collateralSymbol ?? '?');
  const decimals = Number(p.collateralAssetDecimals ?? p.collateralTokenDecimals ?? p.collateralDecimals ?? 18);
  return { token, symbol, decimals };
}

/**
 * Veta (observar) o colateral do M1 se o porteiro estiver ligado e o token for NOVO. Idempotente por token.
 * Isolado em try/catch: observabilidade NUNCA pode derrubar o pipeline de liquidação.
 */
export async function maybeVetCollateralM1(
  deps: PipelineDeps,
  position: Record<string, unknown>,
): Promise<{ skip: boolean; reason?: string }> {
  const tracker = deps.vettingTracker;
  if (!tracker || !deps.env.VETTING_ENABLED) return { skip: false };
  const collateral = extractCollateral(position);
  if (!collateral) return { skip: false };

  // 1) OBSERVAR: veta se for NOVO (idempotente por token; re-vet contínuo = Etapa 6) + emite a transição.
  if (deps.env.VETTING_M1_OBSERVE && !tracker.current(collateral.token, 'motor1')) {
    const chainConfig = deps.ctx.chainConfig;
    const usdc = chainConfig.tokens['USDC'] as Address | undefined;
    if (usdc) {
      try {
        initCache(deps.env.VETTING_SAFETY_CACHE_DIR);
        const verdict = await vetToken({
          motor: 'motor1',
          token: collateral.token,
          symbol: collateral.symbol,
          decimals: collateral.decimals,
          chainConfig,
          client: deps.ctx.client,
          quoteToken: usdc,
          quoteTokenDecimals: 6,
          exitNotionalWei: parseUnits('1', collateral.decimals),
          deepLiquidity: deps.env.VETTING_DEEP_LIQUIDITY,
          maxRoundtripBps: deps.env.VETTING_MAX_ROUNDTRIP_BPS,
          roundtripNotionalUsd: deps.env.VETTING_ROUNDTRIP_USD,
          // M1: SEM noEdgeBlocklist — LSDs/stables são colateral válido (aceitos).
        });
        const transition = tracker.record(verdict);
        if (transition) {
          deps.eventBus?.emit({
            type: transition === 'entered' ? 'token.entered' : 'token.exited',
            timestamp: new Date().toISOString(),
            chain: chainConfig.name,
            mode: deps.env.LIQUIDATOR_MODE,
            severity: 'info',
            token: collateral.token,
            symbol: collateral.symbol,
            motor: 'motor1',
            pair: collateral.symbol,
            reason: verdict.reasons[0] ?? '',
            exitDex: verdict.checks.exitRoute.dex,
            liquidityUsd: verdict.checks.liquidityFloor.usd,
            locked: verdict.checks.lockStatus.locked,
            wouldEnforce: !!deps.vettingEnforceM1,
          });
        }
      } catch {
        // Nunca propaga — vetting M1 é observabilidade, não pode bloquear a liquidação.
      }
    }
  }

  // 2) ENFORCE (Etapa 5): filtro LIGADO (env + toggle ao vivo) → pula colateral reprovado.
  // FAIL-SAFE do M1: só pula se o verdict for reject E o dado for COMPLETO (parcial → NÃO bloqueia,
  // nunca perde uma liquidação lucrativa por falha de RPC/GoPlus). É o oposto do M2 (que rejeita na dúvida).
  if (deps.env.VETTING_M1_ENFORCE && deps.vettingEnforceM1) {
    const entry = tracker.current(collateral.token, 'motor1');
    if (entry && entry.verdict === 'reject' && !entry.partial) {
      return { skip: true, reason: `porteiro M1: colateral ${collateral.symbol} reprovado — ${entry.reason}` };
    }
  }
  return { skip: false };
}

type AnyPublicClient = PublicClient<any, any>;

export interface RevetM1Opts {
  client: AnyPublicClient;
  chainConfig: ChainConfig;
  quoteToken: Address;
  quoteTokenDecimals: number;
  tracker: VettingUniverseTracker;
  eventBus?: EventBus;
  mode: 'dryrun' | 'testnet' | 'mainnet';
  safetyCacheDir: string;
  deepLiquidity?: boolean;
  maxRoundtripBps?: number;
  roundtripNotionalUsd?: number;
  enforce?: boolean;
}

/**
 * Re-vet contínuo do M1 (Etapa 6): re-checa os colaterais do universo (liquidez round-trip + safety) e
 * emite as transições (auto-demote se degradou, auto-promote se recuperou). Chamado num setInterval.
 */
export async function runVettingRevetM1(opts: RevetM1Opts): Promise<{ entered: number; exited: number; checked: number }> {
  initCache(opts.safetyCacheDir);
  return runRevetTick({
    tracker: opts.tracker,
    revet: (entry: VettedEntry) =>
      entry.motor === 'motor1'
        ? vetToken({
            motor: 'motor1',
            token: entry.token as Address,
            symbol: entry.symbol,
            decimals: entry.decimals,
            chainConfig: opts.chainConfig,
            client: opts.client,
            quoteToken: opts.quoteToken,
            quoteTokenDecimals: opts.quoteTokenDecimals,
            exitNotionalWei: parseUnits('1', entry.decimals),
            deepLiquidity: opts.deepLiquidity,
            maxRoundtripBps: opts.maxRoundtripBps,
            roundtripNotionalUsd: opts.roundtripNotionalUsd,
          })
        : Promise.resolve(null),
    onTransition: (verdict, transition) => {
      try {
        opts.eventBus?.emit({
          type: transition === 'entered' ? 'token.entered' : 'token.exited',
          timestamp: new Date().toISOString(),
          chain: opts.chainConfig.name,
          mode: opts.mode,
          severity: 'info',
          token: verdict.token as Address,
          symbol: verdict.symbol,
          motor: 'motor1',
          pair: verdict.symbol,
          reason: verdict.reasons[0] ?? '',
          exitDex: verdict.checks.exitRoute.dex,
          liquidityUsd: verdict.checks.liquidityFloor.usd,
          locked: verdict.checks.lockStatus.locked,
          wouldEnforce: !!opts.enforce,
        });
      } catch {
        /* observabilidade — nunca propaga */
      }
    },
  });
}
