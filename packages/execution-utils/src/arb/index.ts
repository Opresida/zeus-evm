/**
 * Arb module — Motor 2 (Cross-DEX arbitrage).
 *
 * Edge: cobertura + persistência em pares sub-servidos (LSDs/stables), NÃO velocidade.
 * Reusa pricing local (dex-adapters), ZeusArbExecutor, gates e caixa-preta.
 */

export {
  buildArbAllowlist,
  isArbTokenAllowed,
  checkArbPair,
  checkArbRoute,
  type ArbAllowlist,
} from './tokenSafety';
