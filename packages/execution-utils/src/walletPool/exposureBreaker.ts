/**
 * Breaker de exposição AGREGADA (cuidado #1 do Humberto — o CRÍTICO).
 *
 * O `maxTradeWei` do contrato é POR-TX. Com N senders em paralelo, a exposição real vira N× isso —
 * o teto por-tx NÃO protege o conjunto. Este breaker soma a exposição EM VOO de todos os senders e
 * NEGA novos reserves quando o agregado passaria do teto coletivo. É a pré-condição HARD pra ligar
 * o pool: sem ele, 22 senders poderiam ter 22× a exposição que você acha que autorizou.
 *
 * Uso: `tryReserve(sender, amount)` ANTES de despachar; `release(sender, amount)` quando a tx
 * liquida (confirma ou falha). Fail-safe: se a conta interna divergir, nunca fica negativa.
 */

import type { Address } from 'viem';

export interface ExposureStats {
  aggregateWei: bigint;
  maxAggregateWei: bigint;
  utilizationPct: number;
  inFlightTxs: number;
  perSender: Record<string, string>;
}

export class AggregatedExposureBreaker {
  private perSender = new Map<string, bigint>();
  private perSenderTxs = new Map<string, number>();
  private total = 0n;

  /** @param maxAggregateWei teto COLETIVO somando todos os senders (ex: 0.2 ETH = 2× o per-tx de 0.01 × folga). */
  constructor(private readonly maxAggregateWei: bigint) {
    if (maxAggregateWei <= 0n) throw new Error('AggregatedExposureBreaker: maxAggregateWei deve ser > 0');
  }

  /**
   * Tenta reservar `amountWei` pro sender. Retorna false (NEGADO) se o agregado passaria do teto —
   * o caller NÃO deve despachar. Retorna true e contabiliza a reserva se couber.
   */
  tryReserve(sender: Address, amountWei: bigint): boolean {
    if (amountWei < 0n) return false;
    if (this.total + amountWei > this.maxAggregateWei) return false;
    const key = sender.toLowerCase();
    this.perSender.set(key, (this.perSender.get(key) ?? 0n) + amountWei);
    this.perSenderTxs.set(key, (this.perSenderTxs.get(key) ?? 0) + 1);
    this.total += amountWei;
    return true;
  }

  /** Libera a reserva quando a tx liquida (confirma/falha). Clamp em 0 (nunca negativo). */
  release(sender: Address, amountWei: bigint): void {
    const key = sender.toLowerCase();
    const cur = this.perSender.get(key) ?? 0n;
    const next = cur - amountWei <= 0n ? 0n : cur - amountWei;
    this.perSender.set(key, next);
    this.total = this.total - amountWei <= 0n ? 0n : this.total - amountWei;
    const txs = (this.perSenderTxs.get(key) ?? 0) - 1;
    this.perSenderTxs.set(key, txs < 0 ? 0 : txs);
  }

  aggregate(): bigint {
    return this.total;
  }

  /** Quanto ainda cabe sob o teto coletivo. */
  remaining(): bigint {
    const r = this.maxAggregateWei - this.total;
    return r < 0n ? 0n : r;
  }

  stats(): ExposureStats {
    const perSender: Record<string, string> = {};
    for (const [k, v] of this.perSender) if (v > 0n) perSender[k] = v.toString();
    let inFlightTxs = 0;
    for (const n of this.perSenderTxs.values()) inFlightTxs += n;
    const utilizationPct =
      this.maxAggregateWei > 0n ? Number((this.total * 10000n) / this.maxAggregateWei) / 100 : 0;
    return {
      aggregateWei: this.total,
      maxAggregateWei: this.maxAggregateWei,
      utilizationPct,
      inFlightTxs,
      perSender,
    };
  }
}
