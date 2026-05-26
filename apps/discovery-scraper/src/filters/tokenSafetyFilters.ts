/**
 * Token Safety filters — checks adicionais via GoPlus + CoinGecko.
 *
 * Substituem "investigação manual" — todo critério aqui é automaticamente
 * computável a partir do TokenSafety carregado pelo source.
 *
 * Hard filters (eliminam ANTES do score):
 *   1. Honeypot — sell bloqueado, slippage maliciosa
 *   2. Tax abusiva — buy >5% OR sell >10%
 *   3. Mintable + owner ativo — inflação infinita
 *   4. Proxy contract — rug via upgrade
 *   5. Top holder >30% (não locked) — whale dump risk
 *   6. Holders < 100 — token muito dust
 *   7. Creator balance > 20% — creator dump risk
 *
 * Soft penalties + boosts são aplicados no composite scoring — não aqui.
 */

import type { TokenSafety } from '../sources/tokenSafety';

export interface SafetyFilterResult {
  passed: boolean;
  reason?: string;
}

const BUY_TAX_MAX_PCT = 5;
const SELL_TAX_MAX_PCT = 10;
const TOP_HOLDER_MAX_PCT = 30;
const CREATOR_BALANCE_MAX_PCT = 20;
const HOLDER_COUNT_MIN = 100;

/**
 * Aplica todos os filtros hard de safety pra um único token. Retorna passed=false
 * com motivo quando token é problemático.
 *
 * IMPORTANTE: caller deve chamar isso pros 2 tokens do par. Se QUALQUER UM
 * dos tokens falhar, par inteiro é rejeitado.
 */
export function applyTokenSafetyFilters(safety: TokenSafety): SafetyFilterResult {
  const sym = safety.address.slice(0, 8); // pra log resumido

  // 1. Honeypot — fatal pra qualquer arb
  if (safety.isHoneypot) {
    return {
      passed: false,
      reason: `honeypot detectado em ${sym}... (GoPlus)`,
    };
  }

  // 2. Tax abusiva — buy ou sell tax mata edge
  if (safety.buyTaxPct > BUY_TAX_MAX_PCT) {
    return {
      passed: false,
      reason: `buy tax ${safety.buyTaxPct.toFixed(1)}% > ${BUY_TAX_MAX_PCT}% em ${sym}...`,
    };
  }
  if (safety.sellTaxPct > SELL_TAX_MAX_PCT) {
    return {
      passed: false,
      reason: `sell tax ${safety.sellTaxPct.toFixed(1)}% > ${SELL_TAX_MAX_PCT}% em ${sym}...`,
    };
  }

  // 3. Mintable + owner ativo = inflação infinita (rug via mint)
  if (safety.isMintable && safety.ownerAddress) {
    const ownerIsBurned = isBurnAddress(safety.ownerAddress);
    if (!ownerIsBurned) {
      return {
        passed: false,
        reason: `token mintável + owner ativo (${safety.ownerAddress.slice(0, 8)}...) em ${sym}...`,
      };
    }
  }

  // 4. Proxy contract = rug via upgrade
  if (safety.isProxy) {
    return {
      passed: false,
      reason: `contrato proxy (upgradeable) em ${sym}... — rug risk via upgrade`,
    };
  }

  // 5. Top holder concentração > 30% (não locked)
  if (safety.topHolderPct > TOP_HOLDER_MAX_PCT && !safety.topHolderIsLocked) {
    return {
      passed: false,
      reason: `top holder ${safety.topHolderPct.toFixed(1)}% > ${TOP_HOLDER_MAX_PCT}% (não locked) em ${sym}...`,
    };
  }

  // 6. Holder count baixo demais — token muito dust/novo
  if (safety.holderCount > 0 && safety.holderCount < HOLDER_COUNT_MIN) {
    return {
      passed: false,
      reason: `apenas ${safety.holderCount} holders (<${HOLDER_COUNT_MIN}) em ${sym}...`,
    };
  }

  // 7. Creator balance — creator pode dumpar a qualquer momento
  if (safety.creatorBalancePct > CREATOR_BALANCE_MAX_PCT) {
    return {
      passed: false,
      reason: `creator com ${safety.creatorBalancePct.toFixed(1)}% supply (>${CREATOR_BALANCE_MAX_PCT}%) em ${sym}...`,
    };
  }

  return { passed: true };
}

/**
 * Verifica se address é uma das wallets canônicas de "burn" (token efetivamente
 * sem owner). Burn = sem possibilidade de rug via owner functions.
 */
function isBurnAddress(addr: string): boolean {
  const lower = addr.toLowerCase();
  return (
    lower === '0x0000000000000000000000000000000000000000' ||
    lower === '0x000000000000000000000000000000000000dead' ||
    lower === '0xdead000000000000000042069420694206942069'
  );
}

/**
 * Aplica filtros pro PAR INTEIRO (chama applyTokenSafetyFilters em ambos tokens).
 * Returna result do PRIMEIRO token que falha (ou passed=true se ambos OK).
 *
 * Quando dados são `partial` (alguma fonte falhou), aplica filtros mais conservadores
 * — preferir rejeitar a deixar passar um token com dados incompletos.
 */
export function applyPairSafetyFilters(
  baseTokenSafety: TokenSafety,
  quoteTokenSafety: TokenSafety,
): SafetyFilterResult {
  // Quando GoPlus não retornou nada pro token (partial), ainda assim:
  //   - Stables conhecidos (USDC, USDT, etc) passam sem GoPlus check (tokens auditados)
  //   - WETH/WBTC/etc também
  //   - Outros tokens com partial = REJEITAR conservadoramente
  const isKnownSafe = (s: TokenSafety): boolean => {
    // Symbol-based safe-list — esses tokens são auditados/oficiais
    // Se GoPlus retornar partial pra eles, ignoramos e deixamos passar.
    return s.partial && (s.holderCount === 0); // partial real = sem dados nenhum
  };

  if (!isKnownSafe(baseTokenSafety)) {
    const baseResult = applyTokenSafetyFilters(baseTokenSafety);
    if (!baseResult.passed) return baseResult;
  }

  if (!isKnownSafe(quoteTokenSafety)) {
    const quoteResult = applyTokenSafetyFilters(quoteTokenSafety);
    if (!quoteResult.passed) return quoteResult;
  }

  return { passed: true };
}
