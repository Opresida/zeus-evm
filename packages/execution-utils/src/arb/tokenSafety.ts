/**
 * Token Safety — camada de proteção do Motor 2 (arb) contra tokens maliciosos.
 *
 * Arb toca tokens NÃO-auditados (diferente de Aave/Compound que só listam tokens
 * curados). Riscos: fee-on-transfer, honeypot, rebasing, pools manipulados.
 *
 * Defesa em 2 camadas:
 *   1. OFF-CHAIN (este módulo): ALLOWLIST curada — só arbitramos tokens conhecidos.
 *      Elimina 99% do risco e economiza gas (não tenta tokens ruins).
 *   2. ON-CHAIN (ZeusArbExecutor, já existe): balance-check real antes/depois +
 *      minProfitWei. Rede de segurança final — se algo passar, a tx reverte
 *      atomicamente (atomic-only). Confirmado em ZeusArbExecutor.sol:91-98.
 *
 * O screener dinâmico de fee-on-transfer (state-override eth_call) é fase futura
 * — serve pra EXPANDIR a allowlist com segurança, não pro hot path. A allowlist
 * curada + balance-check on-chain já cobrem o risco no v1.
 */

import type { Address } from 'viem';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface ArbAllowlist {
  /** Set de token addresses lowercase aprovados pro arb. */
  tokens: Set<string>;
}

/**
 * Constrói allowlist a partir dos tokens já curados do chain-config + extras.
 * Os tokens em chainConfig.tokens (WETH/USDC/cbETH/wstETH/etc) já são auditados
 * e usados pelos protocolos de lending — base segura pro arb.
 */
export function buildArbAllowlist(
  chainTokens: Record<string, Address>,
  extra: Address[] = [],
): ArbAllowlist {
  const tokens = new Set<string>();
  for (const addr of Object.values(chainTokens)) {
    if (addr && addr !== ZERO) tokens.add(addr.toLowerCase());
  }
  for (const addr of extra) {
    if (addr && addr !== ZERO) tokens.add(addr.toLowerCase());
  }
  return { tokens };
}

/** Token individual está na allowlist? */
export function isArbTokenAllowed(allowlist: ArbAllowlist, token: Address): boolean {
  return allowlist.tokens.has(token.toLowerCase());
}

/**
 * Par é seguro pra arb? AMBOS os tokens precisam estar na allowlist.
 * Retorna { ok, reason } pra logging no pipeline.
 */
export function checkArbPair(
  allowlist: ArbAllowlist,
  tokenA: Address,
  tokenB: Address,
): { ok: boolean; reason?: string } {
  if (!isArbTokenAllowed(allowlist, tokenA)) {
    return { ok: false, reason: `token ${tokenA} fora da allowlist de arb` };
  }
  if (!isArbTokenAllowed(allowlist, tokenB)) {
    return { ok: false, reason: `token ${tokenB} fora da allowlist de arb` };
  }
  return { ok: true };
}

/**
 * Rota inteira (multi-hop/triangular) é segura? TODOS os tokens do path na allowlist.
 */
export function checkArbRoute(
  allowlist: ArbAllowlist,
  pathTokens: readonly Address[],
): { ok: boolean; reason?: string } {
  for (const t of pathTokens) {
    if (!isArbTokenAllowed(allowlist, t)) {
      return { ok: false, reason: `token ${t} no path fora da allowlist` };
    }
  }
  return { ok: true };
}
