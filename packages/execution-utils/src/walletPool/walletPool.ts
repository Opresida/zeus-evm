/**
 * Wallet-pool (Motor 1 / pré-liquidação) — N EOAs derivados de UM seed-mestre.
 *
 * Doutrina (cuidado #2 do Humberto): o seed é a CHAVE-MESTRA — isolada, dedicada ao pool, nunca
 * reusada de outro projeto. Quem tem o seed controla as N carteiras. Em testnet usa seed testnet-only;
 * em mainnet, seed exclusiva guardada com o mesmo rigor da chave do contrato.
 *
 * Edge do pré-liq = PRESENÇA PARALELA (não latência): N senders disputam o grind em paralelo, igual
 * o líder (44 EOAs). Este módulo só DERIVA e SELECIONA — não envia nada sozinho. Wiring no dispatch +
 * movimentação real de fundo são passos da fase mainnet (após DRY_RUN provar o edge).
 */

import { mnemonicToAccount } from 'viem/accounts';
import type { Address } from 'viem';

export interface PooledSender {
  /** Índice de derivação HD (m/44'/60'/0'/0/index). */
  index: number;
  address: Address;
  /** Conta viem pronta pra assinar (deriva do seed-mestre). */
  account: ReturnType<typeof mnemonicToAccount>;
}

export class WalletPool {
  readonly senders: PooledSender[];
  private cursor = 0;

  /**
   * @param mnemonic seed-mestre (BIP-39). NUNCA reusar de outro projeto.
   * @param size número de EOAs (ex: ~22 = metade do líder de 44).
   * @param startIndex índice HD inicial (default 0).
   */
  constructor(mnemonic: string, size: number, startIndex = 0) {
    if (!mnemonic || mnemonic.trim().split(/\s+/).length < 12) {
      throw new Error('WalletPool: seed-mestre inválido (esperado mnemônico BIP-39 com ≥12 palavras)');
    }
    if (size < 1) throw new Error('WalletPool: size deve ser ≥ 1');
    this.senders = Array.from({ length: size }, (_, i) => {
      const idx = startIndex + i;
      const account = mnemonicToAccount(mnemonic, { addressIndex: idx });
      return { index: idx, address: account.address, account };
    });
  }

  get size(): number {
    return this.senders.length;
  }

  addresses(): Address[] {
    return this.senders.map((s) => s.address);
  }

  byAddress(address: Address): PooledSender | undefined {
    const lower = address.toLowerCase();
    return this.senders.find((s) => s.address.toLowerCase() === lower);
  }

  /** Seleção round-robin (presença distribuída entre os senders). */
  next(): PooledSender {
    const s = this.senders[this.cursor % this.senders.length]!;
    this.cursor = (this.cursor + 1) % this.senders.length;
    return s;
  }

  /**
   * Seleção do MENOS ocupado: dado o nº de tx em voo por sender, escolhe o de menor carga
   * (desempate por índice). Melhor que round-robin puro pro grind — evita empilhar num só.
   */
  leastBusy(inFlightBySender: Map<string, number>): PooledSender {
    let best = this.senders[0]!;
    let bestLoad = inFlightBySender.get(best.address.toLowerCase()) ?? 0;
    for (const s of this.senders) {
      const load = inFlightBySender.get(s.address.toLowerCase()) ?? 0;
      if (load < bestLoad) {
        best = s;
        bestLoad = load;
      }
    }
    return best;
  }
}
