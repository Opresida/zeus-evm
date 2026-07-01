/**
 * Wallet-pool — ORQUESTRADOR: une as 4 peças (pool + breaker agregado + nonce + funding) no momento
 * do envio. Seleciona o sender menos ocupado, RESERVA exposição sob o teto coletivo (cuidado #1),
 * sincroniza+aloca o nonce local (cuidado #4) e devolve a wallet daquele sender.
 *
 * `acquire` retorna null quando o teto AGREGADO estouraria → o caller NÃO dispara (a trava que o
 * maxTradeWei por-tx não dá). `release(success)` libera a exposição; em falha de nonce, invalida p/ re-sync.
 *
 * Opt-in: só roda com WALLET_POOL_ENABLED. Default OFF → o dispatch usa o sender único de sempre.
 */

import type { Address, PublicClient, WalletClient } from 'viem';
import { WalletPool, type PooledSender } from './walletPool';
import { NoncePool } from './noncePool';
import { AggregatedExposureBreaker } from './exposureBreaker';

type AnyPublicClient = PublicClient<any, any>;
type AnyWalletClient = WalletClient<any, any, any>;

export interface AcquiredSender {
  sender: PooledSender;
  wallet: AnyWalletClient;
  nonce: number;
  /** Libera a exposição reservada. `success=false` → invalida o nonce do sender (força re-sync). */
  release: (success: boolean) => void;
}

export class WalletPoolOrchestrator {
  private readonly inFlight = new Map<string, number>();
  private readonly wallets = new Map<string, AnyWalletClient>();

  constructor(
    private readonly pool: WalletPool,
    private readonly nonces: NoncePool,
    private readonly breaker: AggregatedExposureBreaker,
    /** Fábrica de WalletClient por sender (cada EOA tem sua wallet de assinatura). */
    private readonly makeWallet: (sender: PooledSender) => AnyWalletClient,
  ) {}

  get size(): number {
    return this.pool.size;
  }

  addresses(): Address[] {
    return this.pool.addresses();
  }

  stats() {
    return { ...this.breaker.stats(), poolSize: this.pool.size };
  }

  private walletFor(sender: PooledSender): AnyWalletClient {
    const key = sender.address.toLowerCase();
    let w = this.wallets.get(key);
    if (!w) {
      w = this.makeWallet(sender);
      this.wallets.set(key, w);
    }
    return w;
  }

  /**
   * Adquire um sender pra UMA tx, reservando `exposureWei` sob o teto coletivo. Retorna null se o
   * agregado estouraria (NÃO disparar) — esta é a pré-condição HARD do pool (cuidado #1 do Humberto).
   */
  async acquire(client: AnyPublicClient, exposureWei: bigint): Promise<AcquiredSender | null> {
    const sender = this.pool.leastBusy(this.inFlight);
    // 1. Teto AGREGADO (soma de todos os senders) — nega se estouraria.
    if (!this.breaker.tryReserve(sender.address, exposureWei)) return null;

    // 2. Nonce local: sincroniza 1x com a chain, depois aloca sequencial.
    try {
      if (this.nonces.requiresSync(sender.address)) {
        const onchain = await client.getTransactionCount({ address: sender.address, blockTag: 'pending' });
        this.nonces.sync(sender.address, Number(onchain));
      }
    } catch {
      // sem nonce confiável → desfaz a reserva e nega (fail-safe).
      this.breaker.release(sender.address, exposureWei);
      return null;
    }
    const nonce = this.nonces.allocate(sender.address);

    const key = sender.address.toLowerCase();
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);

    return {
      sender,
      wallet: this.walletFor(sender),
      nonce,
      release: (success: boolean) => {
        this.breaker.release(sender.address, exposureWei);
        const n = (this.inFlight.get(key) ?? 1) - 1;
        this.inFlight.set(key, n < 0 ? 0 : n);
        if (!success) this.nonces.invalidate(sender.address);
      },
    };
  }
}

/** Monta o orquestrador a partir do mnemônico-mestre + parâmetros. makeWallet injeta a fábrica viem. */
export function buildWalletPoolOrchestrator(opts: {
  mnemonic: string;
  size: number;
  startIndex: number;
  maxAggregateWei: bigint;
  makeWallet: (sender: PooledSender) => AnyWalletClient;
}): WalletPoolOrchestrator {
  const pool = new WalletPool(opts.mnemonic, opts.size, opts.startIndex);
  const nonces = new NoncePool();
  const breaker = new AggregatedExposureBreaker(opts.maxAggregateWei);
  return new WalletPoolOrchestrator(pool, nonces, breaker, opts.makeWallet);
}
