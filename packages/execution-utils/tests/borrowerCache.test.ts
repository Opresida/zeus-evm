/**
 * Smoke test do BorrowerCache acumulativo (Doutrina — cobertura on-chain).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address } from 'viem';

import { BorrowerCache } from '@zeus-evm/aave-discovery';

const A = '0xAaAa000000000000000000000000000000000001' as Address;
const B = '0xbBbB000000000000000000000000000000000001' as Address;
const C = '0xCccC000000000000000000000000000000000001' as Address;

function freshDir(): string {
  return join(tmpdir(), `zeus-borrowers-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
}

describe('BorrowerCache — Doutrina cobertura acumulativa', () => {
  let baseDir: string;

  beforeEach(() => { baseDir = freshDir(); });
  afterEach(() => { if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true }); });

  it('add dedupe + retorna contagem de novos', () => {
    const cache = new BorrowerCache({ baseDir, chain: 'base', market: 'seamless' });
    expect(cache.add([A, B])).toBe(2);
    expect(cache.add([A, C])).toBe(1); // A já existe, só C é novo
    expect(cache.size()).toBe(3);
  });

  it('all retorna borrowers lowercase', () => {
    const cache = new BorrowerCache({ baseDir, chain: 'base', market: 'seamless' });
    cache.add([A]);
    expect(cache.all()).toContain(A.toLowerCase());
  });

  it('remove (auto-poda) tira do set', () => {
    const cache = new BorrowerCache({ baseDir, chain: 'base', market: 'seamless' });
    cache.add([A, B, C]);
    expect(cache.remove([B])).toBe(1);
    expect(cache.size()).toBe(2);
    expect(cache.all()).not.toContain(B.toLowerCase());
  });

  it('persistência: save + reload mantém set', () => {
    const cache1 = new BorrowerCache({ baseDir, chain: 'base', market: 'seamless' });
    cache1.add([A, B, C]);
    cache1.save();

    // Nova instância (simula restart) carrega o snapshot
    const cache2 = new BorrowerCache({ baseDir, chain: 'base', market: 'seamless' });
    expect(cache2.size()).toBe(3);
    expect(cache2.all()).toContain(A.toLowerCase());
    expect(cache2.all()).toContain(C.toLowerCase());
  });

  it('markets diferentes = arquivos isolados', () => {
    const seamless = new BorrowerCache({ baseDir, chain: 'base', market: 'seamless' });
    seamless.add([A, B]);
    seamless.save();

    const zerolend = new BorrowerCache({ baseDir, chain: 'base', market: 'zerolend' });
    expect(zerolend.size()).toBe(0); // isolado do seamless
    zerolend.add([C]);
    zerolend.save();

    // Recarrega seamless — não foi afetado
    const seamlessReload = new BorrowerCache({ baseDir, chain: 'base', market: 'seamless' });
    expect(seamlessReload.size()).toBe(2);
  });

  it('acúmulo ao longo de ticks (simula cobertura crescente)', () => {
    const cache = new BorrowerCache({ baseDir, chain: 'base', market: 'seamless' });
    // Tick 1: janela vê A, B
    cache.add([A, B]);
    // Tick 2: janela vê B, C (B repetido) → acumula C
    cache.add([B, C]);
    // Cobertura agora é A+B+C mesmo que cada janela só viu 2
    expect(cache.size()).toBe(3);
  });
});
