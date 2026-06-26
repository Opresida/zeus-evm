/**
 * Wallet-pool orquestrador — une pool + breaker agregado + nonce no envio. O teste prova:
 *   - seleção do menos ocupado + reserva no breaker AGREGADO (cuidado #1);
 *   - acquire NEGA (null) quando o teto coletivo estouraria;
 *   - nonce: sincroniza 1x e aloca sequencial por sender (cuidado #4);
 *   - release libera exposição; falha invalida o nonce.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { buildWalletPoolOrchestrator } from '../src/walletPool/orchestrator';

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

function mockClient(pendingNonce = 0): { getTransactionCount: ReturnType<typeof vi.fn> } {
  return { getTransactionCount: vi.fn(async () => pendingNonce) };
}
// makeWallet só precisa devolver algo identificável (não envia de verdade no teste).
const makeWallet = (s: { address: Address }) => ({ account: { address: s.address } }) as never;

describe('WalletPoolOrchestrator', () => {
  it('deriva o pool e expõe os endereços', () => {
    const o = buildWalletPoolOrchestrator({ mnemonic: TEST_MNEMONIC, size: 5, startIndex: 0, maxAggregateWei: 1000n, makeWallet });
    expect(o.size).toBe(5);
    expect(o.addresses().length).toBe(5);
  });

  it('acquire reserva no breaker e aloca nonce; release libera', async () => {
    const o = buildWalletPoolOrchestrator({ mnemonic: TEST_MNEMONIC, size: 3, startIndex: 0, maxAggregateWei: 100n, makeWallet });
    const client = mockClient(7);
    const a = await o.acquire(client as never, 40n);
    expect(a).not.toBeNull();
    expect(a!.nonce).toBe(7); // 1º nonce = pending count
    expect(o.stats().aggregateWei).toBe(40n);
    a!.release(true);
    expect(o.stats().aggregateWei).toBe(0n);
  });

  it('NEGA (null) quando o teto AGREGADO estouraria (cuidado #1)', async () => {
    const o = buildWalletPoolOrchestrator({ mnemonic: TEST_MNEMONIC, size: 3, startIndex: 0, maxAggregateWei: 100n, makeWallet });
    const client = mockClient(0);
    const a = await o.acquire(client as never, 60n);
    const b = await o.acquire(client as never, 60n); // 120 > 100 → NEGADO mesmo com 3 senders
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(o.stats().aggregateWei).toBe(60n);
  });

  it('nonce sequencial por sender; sincroniza só 1x (ou re-sync após falha)', async () => {
    const o = buildWalletPoolOrchestrator({ mnemonic: TEST_MNEMONIC, size: 1, startIndex: 0, maxAggregateWei: 10_000n, makeWallet });
    const client = mockClient(5);
    const a1 = await o.acquire(client as never, 1n);
    const a2 = await o.acquire(client as never, 1n);
    expect(a1!.nonce).toBe(5);
    expect(a2!.nonce).toBe(6); // sequencial, sem re-consultar a chain
    expect(client.getTransactionCount).toHaveBeenCalledTimes(1);
    // falha → invalida → re-sync na próxima
    a2!.release(false);
    const a3 = await o.acquire(client as never, 1n);
    expect(client.getTransactionCount).toHaveBeenCalledTimes(2); // re-sincronizou
    expect(a3!.nonce).toBe(5);
  });
});
