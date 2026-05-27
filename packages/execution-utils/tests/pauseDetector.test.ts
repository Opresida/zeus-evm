/**
 * Smoke test do PauseDetector (Grupo B).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';

import { PauseDetector } from '../src/protocols';

function makeClient(readContract: ReturnType<typeof vi.fn>, getBlockNumber = vi.fn().mockResolvedValue(1000n)) {
  return { readContract, getBlockNumber } as any;
}

const POOL = '0xaaaa000000000000000000000000000000000001' as Address;
const COMET = '0xbbbb000000000000000000000000000000000001' as Address;
const USDC = '0x1111000000000000000000000000000000000001' as Address;
const WETH = '0x2222000000000000000000000000000000000001' as Address;

describe('PauseDetector — Grupo B', () => {
  it('Aave pool não pausado → paused=false', async () => {
    const readContract = vi.fn().mockResolvedValue(false);
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkAavePoolPause(POOL);
    expect(r.paused).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it('Aave pool pausado → paused=true com reason', async () => {
    const readContract = vi.fn().mockResolvedValue(true);
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkAavePoolPause(POOL);
    expect(r.paused).toBe(true);
    expect(r.reason).toContain('aave pool global pause');
  });

  it('Aave asset paused via bit 60 do configuration data', async () => {
    // Bit 60 setado → asset pausado
    const dataWithBit60 = 1n << 60n;
    const readContract = vi.fn().mockResolvedValue({ data: dataWithBit60 });
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkAaveAssetPause(POOL, USDC);
    expect(r.paused).toBe(true);
    expect(r.reason).toContain('paused');
  });

  it('Aave asset NÃO pausado: bit 60 zero', async () => {
    // bits 0-59 cheios, mas bit 60 = 0 → não pausado
    const dataWithoutBit60 = (1n << 60n) - 1n;
    const readContract = vi.fn().mockResolvedValue({ data: dataWithoutBit60 });
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkAaveAssetPause(POOL, USDC);
    expect(r.paused).toBe(false);
  });

  it('Comet absorb paused → paused=true', async () => {
    const readContract = vi.fn().mockResolvedValue(true);
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkCometAbsorbPause(COMET);
    expect(r.paused).toBe(true);
    expect(r.reason).toContain('comet absorb');
  });

  it('RPC erro → fail-open (paused=false, com reason)', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('RPC timeout'));
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkAavePoolPause(POOL);
    expect(r.paused).toBe(false);
    expect(r.reason).toContain('RPC error');
  });

  it('checkAaveLiquidation: pool OK + assets OK → não pausado', async () => {
    const readContract = vi.fn().mockImplementation((args: { functionName: string }) => {
      if (args.functionName === 'paused') return Promise.resolve(false);
      return Promise.resolve({ data: 0n });
    });
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkAaveLiquidation(POOL, USDC, WETH);
    expect(r.paused).toBe(false);
  });

  it('checkAaveLiquidation: pool pausado → retorna pause global', async () => {
    const readContract = vi.fn().mockImplementation((args: { functionName: string }) => {
      if (args.functionName === 'paused') return Promise.resolve(true);
      return Promise.resolve({ data: 0n });
    });
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkAaveLiquidation(POOL, USDC, WETH);
    expect(r.paused).toBe(true);
    expect(r.reason).toContain('global');
  });

  it('checkAaveLiquidation: collateral pausado → retorna asset pause', async () => {
    const readContract = vi.fn().mockImplementation((args: { functionName: string; args?: any[] }) => {
      if (args.functionName === 'paused') return Promise.resolve(false);
      // Configuration: só WETH (collateral) tem bit 60 setado
      const asset = (args.args?.[0] as string).toLowerCase();
      const data = asset === WETH.toLowerCase() ? 1n << 60n : 0n;
      return Promise.resolve({ data });
    });
    const detector = new PauseDetector(makeClient(readContract));

    const r = await detector.checkAaveLiquidation(POOL, USDC, WETH);
    expect(r.paused).toBe(true);
    expect(r.reason).toContain(WETH);
  });

  it('cache: 2ª lookup no mesmo bloco não chama RPC', async () => {
    const readContract = vi.fn().mockResolvedValue(false);
    const getBlockNumber = vi.fn().mockResolvedValue(1000n);
    const detector = new PauseDetector(makeClient(readContract, getBlockNumber));

    await detector.checkAavePoolPause(POOL);
    await detector.checkAavePoolPause(POOL);

    expect(readContract).toHaveBeenCalledTimes(1); // 2ª foi do cache
  });

  it('cache expira após TTL blocks', async () => {
    const readContract = vi.fn().mockResolvedValue(false);
    let block = 1000n;
    const getBlockNumber = vi.fn().mockImplementation(() => Promise.resolve(block));
    const detector = new PauseDetector(makeClient(readContract, getBlockNumber), { cacheTtlBlocks: 2 });

    await detector.checkAavePoolPause(POOL);
    block = 1003n; // > TTL
    await detector.checkAavePoolPause(POOL);

    expect(readContract).toHaveBeenCalledTimes(2);
  });
});
