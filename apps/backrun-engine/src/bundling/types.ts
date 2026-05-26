/**
 * Tipos compartilhados pelo bundle relay system.
 *
 * Relays suportados (interface uniforme):
 *   - Flashbots (Ethereum L1 + alguns L2s)
 *   - FastLane Atlas (Base + Polygon)
 *   - Blocknative (fallback / Ethereum)
 *   - bloXroute (Ethereum)
 *
 * Cada relay implementa BundleRelay e expõe `submit(bundle)`.
 * O `relayRouter` multiplexa pra todos relays disponíveis em paralelo,
 * coletando resultados via Promise.allSettled.
 */

import type { Address, Hex } from 'viem';

/** Identificador do relay. */
export type RelayName = 'flashbots' | 'atlas' | 'bloxroute' | 'blocknative';

/**
 * Bundle = lista de raw signed tx hex. Pra backrun puro do ZEUS é tipicamente 1 tx
 * (a chamada `executeFlashloanBackrun`). Quando integrarmos backrun de outras whales,
 * incluímos a whale tx hash original (não nossa) como referência ANCHOR — algumas
 * relays exigem isso pra fixar ordem.
 */
export interface SubmitBundleInput {
  /** Raw signed tx hex (a tx do nosso bot, pronta). */
  signedTx: Hex;
  /** Bloco alvo (number). Bundles típicos miram next-block. */
  targetBlockNumber: bigint;
  /** Hash da whale tx pending que estamos backrun (apenas referência, não submetemos). */
  anchorTxHash?: Hex;
  /** ID lógico do bundle pra correlação em logs (default = um random). */
  bundleId?: string;
  /** ChainId pra relay routing. */
  chainId: number;
}

export type SubmitBundleResult =
  | { ok: true; relay: RelayName; bundleHash: string; submittedAt: number }
  | { ok: false; relay: RelayName; error: string };

export interface BundleRelay {
  readonly name: RelayName;
  /** Indica se o relay suporta a chainId passada. */
  supports(chainId: number): boolean;
  submit(input: SubmitBundleInput): Promise<SubmitBundleResult>;
}

/**
 * Configuração compartilhada de relays — caller passa URLs/keys via env.
 */
export interface RelayConfig {
  /** URL do Flashbots relay. Default: https://relay.flashbots.net (mainnet). */
  flashbotsUrl?: string;
  /** URL do FastLane Atlas Base. Vazio = desabilita Atlas. */
  atlasUrl?: string;
  /** URL do Blocknative MEV-Share. */
  blocknativeUrl?: string;
  /** URL bloXroute. */
  bloxrouteUrl?: string;
  /** Chave de auth pro Flashbots (signing key, formato Ethereum private key). */
  flashbotsAuthKey?: Hex;
  /** Identidade do bot — Flashbots tracks reputation por endereço signing. */
  identityAddress?: Address;
  /** Timeout em ms (default 4s — bundles morrem em ~1 bloco se não submitted rápido). */
  timeoutMs?: number;
}
