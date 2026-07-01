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

import { parseUnits, type Address } from 'viem';
import { vetToken, initCache } from '@zeus-evm/execution-utils';
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
export async function maybeVetCollateralM1(deps: PipelineDeps, position: Record<string, unknown>): Promise<void> {
  const tracker = deps.vettingTracker;
  if (!tracker || !deps.env.VETTING_ENABLED || !deps.env.VETTING_M1_OBSERVE) return;
  const collateral = extractCollateral(position);
  if (!collateral) return;
  if (tracker.current(collateral.token, 'motor1')) return; // já vetado (re-vet contínuo = Etapa 6)

  const chainConfig = deps.ctx.chainConfig;
  const usdc = chainConfig.tokens['USDC'] as Address | undefined;
  if (!usdc) return;

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
      // M1: SEM noEdgeBlocklist — LSDs/stables são colateral válido (aceitos).
    });
    const transition = tracker.record(verdict);
    if (!transition) return;
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
      wouldEnforce: !!deps.env.VETTING_M1_ENFORCE,
    });
  } catch {
    // Nunca propaga — vetting M1 é observabilidade, não pode bloquear a liquidação.
  }
}
