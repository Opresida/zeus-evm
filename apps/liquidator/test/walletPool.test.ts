/**
 * Wallet-pool (Fase 2) — testes dos 4 cuidados: derivação (seed), nonce-pool, breaker AGREGADO, funding.
 */

import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  WalletPool,
  NoncePool,
  AggregatedExposureBreaker,
  planGasTopUps,
  planGasSweeps,
  totalTopUpWei,
} from '../src/walletPool';

// Mnemônico de teste público (NUNCA usar com fundo real) — só pra derivação determinística.
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

describe('WalletPool — derivação do seed-mestre (cuidado #2)', () => {
  it('deriva N EOAs determinísticos e únicos', () => {
    const pool = new WalletPool(TEST_MNEMONIC, 22);
    expect(pool.size).toBe(22);
    const addrs = pool.addresses();
    expect(new Set(addrs.map((a) => a.toLowerCase())).size).toBe(22); // todos únicos
    // determinístico: idx0 do mnemônico de teste é o endereço canônico conhecido.
    expect(addrs[0]?.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('rejeita seed inválida (fail-safe)', () => {
    expect(() => new WalletPool('palavras de menos', 5)).toThrow();
    expect(() => new WalletPool('', 5)).toThrow();
  });

  it('round-robin cicla por todos', () => {
    const pool = new WalletPool(TEST_MNEMONIC, 3);
    const seq = [pool.next(), pool.next(), pool.next(), pool.next()].map((s) => s.index);
    expect(seq).toEqual([0, 1, 2, 0]);
  });

  it('leastBusy escolhe o de menor carga', () => {
    const pool = new WalletPool(TEST_MNEMONIC, 3);
    const load = new Map<string, number>([
      [pool.senders[0]!.address.toLowerCase(), 5],
      [pool.senders[1]!.address.toLowerCase(), 1],
      [pool.senders[2]!.address.toLowerCase(), 3],
    ]);
    expect(pool.leastBusy(load).index).toBe(1);
  });
});

describe('NoncePool — nonce local por sender (cuidado #4)', () => {
  const A = '0x000000000000000000000000000000000000000A' as Address;

  it('exige sync antes de alocar (não chuta nonce)', () => {
    const np = new NoncePool();
    expect(np.requiresSync(A)).toBe(true);
    expect(() => np.allocate(A)).toThrow();
  });

  it('aloca sequencial após sync', () => {
    const np = new NoncePool();
    np.sync(A, 10);
    expect(np.allocate(A)).toBe(10);
    expect(np.allocate(A)).toBe(11);
    expect(np.allocate(A)).toBe(12);
    expect(np.peek(A)).toBe(13);
  });

  it('invalidate força re-sync', () => {
    const np = new NoncePool();
    np.sync(A, 5);
    np.allocate(A);
    np.invalidate(A);
    expect(np.requiresSync(A)).toBe(true);
    expect(() => np.allocate(A)).toThrow();
    np.sync(A, 6); // re-lê da chain
    expect(np.allocate(A)).toBe(6);
  });
});

describe('AggregatedExposureBreaker — teto coletivo (cuidado #1, CRÍTICO)', () => {
  const A = '0x00000000000000000000000000000000000000Aa' as Address;
  const B = '0x00000000000000000000000000000000000000Bb' as Address;

  it('soma exposição entre senders e NEGA acima do teto', () => {
    const br = new AggregatedExposureBreaker(100n);
    expect(br.tryReserve(A, 60n)).toBe(true);
    expect(br.tryReserve(B, 40n)).toBe(true); // total 100 = teto, ainda cabe
    expect(br.aggregate()).toBe(100n);
    expect(br.tryReserve(A, 1n)).toBe(false); // estouraria → NEGADO
  });

  it('o per-tx NÃO basta: N senders somam (prova do cuidado #1)', () => {
    // teto coletivo 100; cada "tx" reserva 30. O 4º (120) seria negado mesmo cada um < teto.
    const br = new AggregatedExposureBreaker(100n);
    expect(br.tryReserve(A, 30n)).toBe(true);
    expect(br.tryReserve(B, 30n)).toBe(true);
    expect(br.tryReserve(A, 30n)).toBe(true); // 90
    expect(br.tryReserve(B, 30n)).toBe(false); // 120 > 100 → barra o N×
  });

  it('release libera espaço e nunca fica negativo', () => {
    const br = new AggregatedExposureBreaker(100n);
    br.tryReserve(A, 80n);
    br.release(A, 80n);
    expect(br.aggregate()).toBe(0n);
    br.release(A, 999n); // over-release não vira negativo
    expect(br.aggregate()).toBe(0n);
    expect(br.tryReserve(A, 100n)).toBe(true);
  });

  it('stats reporta utilização e tx em voo', () => {
    const br = new AggregatedExposureBreaker(200n);
    br.tryReserve(A, 50n);
    br.tryReserve(B, 50n);
    const s = br.stats();
    expect(s.aggregateWei).toBe(100n);
    expect(s.utilizationPct).toBe(50);
    expect(s.inFlightTxs).toBe(2);
  });
});

describe('Funding/sweep planner (cuidado #3) — puro, não move fundo', () => {
  const A = '0x00000000000000000000000000000000000000A1' as Address;
  const B = '0x00000000000000000000000000000000000000B2' as Address;

  it('top-up só pros abaixo do mínimo, até o alvo', () => {
    const bal = new Map<Address, bigint>([
      [A, 1n], // abaixo do min(5) → reabastece até 10 = +9
      [B, 8n], // acima do min → não mexe
    ]);
    const plan = planGasTopUps(bal, 5n, 10n);
    expect(plan).toEqual([{ address: A, amountWei: 9n }]);
    expect(totalTopUpWei(plan)).toBe(9n);
  });

  it('rejeita target < min', () => {
    expect(() => planGasTopUps(new Map(), 10n, 5n)).toThrow();
  });

  it('sweep devolve o excedente acima do buffer', () => {
    const bal = new Map<Address, bigint>([
      [A, 100n], // > keep(10) → varre 90
      [B, 5n], // < keep → não varre
    ]);
    expect(planGasSweeps(bal, 10n)).toEqual([{ address: A, amountWei: 90n }]);
  });
});
