import { describe, expect, it } from 'vitest';
import { vetToken, type VetTokenOpts } from '../src/vetting/tokenVetting';
import type { TokenSafety } from '../src/vetting/tokenSafety';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const CBETH = '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22' as const;
const MEME = '0x0000000000000000000000000000000000001234' as const;

/** TokenSafety com defaults SEGUROS (passa o applyTokenSafetyFilters). */
function safe(overrides: Partial<TokenSafety> = {}): TokenSafety {
  return {
    address: MEME,
    chainId: 8453,
    isHoneypot: false,
    buyTaxPct: 0,
    sellTaxPct: 0,
    isMintable: false,
    isProxy: false,
    ownerAddress: null,
    ownerBalancePct: 0,
    creatorBalancePct: 0,
    holderCount: 5000,
    topHolderPct: 8,
    topHolderIsLocked: false,
    lpLockedPct: 0,
    lpLockerTag: null,
    lpUnlockAtSec: null,
    isOpenSource: true,
    isInDex: true,
    hasCoingeckoCoverage: true,
    isListedOnCexTier1: false,
    cexListings: [],
    fetchedAt: 0,
    partial: false,
    ...overrides,
  };
}

const base = (over: Partial<VetTokenOpts> = {}): VetTokenOpts => ({
  motor: 'motor2',
  token: MEME,
  symbol: 'MEME',
  decimals: 18,
  chainConfig: { chainId: 8453 } as never,
  client: {} as never,
  quoteToken: USDC,
  quoteTokenDecimals: 6,
  exitNotionalWei: 10n ** 18n, // ~1 token; com bestSwap injetado o valor exato não importa
  nowIso: '2026-06-30T12:00:00.000Z',
  ...over,
});

// bestSwap injetado: devolve uma saída viável na Aerodrome (amountOut em USDC=6dec).
const okSwap = async () => ({ source: 'Aerodrome stable', amountOut: 1_000_000_000n }) as never; // 1000 USDC
const noSwap = async () => null;

describe('vetToken — porteiro de tokens', () => {
  it('PASS: token seguro com saída → verdict pass + motivo PT-BR', async () => {
    const v = await vetToken(base(), { fetchSafety: async () => [safe()], bestSwap: okSwap });
    expect(v.verdict).toBe('pass');
    expect(v.checks.exitRoute).toMatchObject({ ok: true, dex: 'Aerodrome stable' });
    expect(v.checks.safety.ok).toBe(true);
    expect(v.reasons[0]).toContain('entrou');
    expect(v.reasons[0]).toContain('Aerodrome');
  });

  it('REJECT: honeypot → bloqueado com motivo claro', async () => {
    const v = await vetToken(base(), { fetchSafety: async () => [safe({ isHoneypot: true })], bestSwap: okSwap });
    expect(v.verdict).toBe('reject');
    expect(v.reasons.some((r) => r.includes('honeypot'))).toBe(true);
  });

  it('REJECT: sem rota de saída em nenhuma DEX', async () => {
    const v = await vetToken(base(), { fetchSafety: async () => [safe()], bestSwap: noSwap });
    expect(v.verdict).toBe('reject');
    expect(v.checks.exitRoute.ok).toBe(false);
    expect(v.reasons.some((r) => r.includes('saída'))).toBe(true);
  });

  it('per-motor: LSD na blocklist no-edge → reject(motor2) "sem edge", pass(motor1)', async () => {
    const noEdge = new Set([CBETH.toLowerCase()]);
    const m2 = await vetToken(base({ motor: 'motor2', token: CBETH, symbol: 'cbETH', noEdgeBlocklist: noEdge }), {
      fetchSafety: async () => [safe({ address: CBETH })],
      bestSwap: okSwap,
    });
    const m1 = await vetToken(base({ motor: 'motor1', token: CBETH, symbol: 'cbETH', noEdgeBlocklist: noEdge }), {
      fetchSafety: async () => [safe({ address: CBETH })],
      bestSwap: okSwap,
    });
    expect(m2.verdict).toBe('reject');
    expect(m2.reasons.some((r) => r.includes('sem edge'))).toBe(true);
    expect(m1.verdict).toBe('pass'); // motor1 ignora o gate de edge (é o colateral da pré-liq)
  });

  it('fail-safe (dado parcial): fetchSafety lança → safety reprova (caller decide o fail-safe por motor)', async () => {
    const v = await vetToken(base(), {
      fetchSafety: async () => {
        throw new Error('GoPlus fora');
      },
      bestSwap: okSwap,
    });
    expect(v.verdict).toBe('reject');
    expect(v.checks.safety.ok).toBe(false);
    expect(v.partial).toBe(true); // fail-safe do M1 lê isto: parcial → NÃO bloqueia a liquidação
  });

  it('Etapa 6 (deep): round-trip com perda alta → liquidez fina → REPROVA', async () => {
    // buy (USDC→token) devolve 100 tokens por $1000; sell (token→USDC) devolve só $900 (10% de perda).
    const lossySwap = async (o: { tokenIn: string }) =>
      (o.tokenIn === USDC
        ? { source: 'x', amountOut: 100n * 10n ** 18n }
        : { source: 'x', amountOut: 900n * 10n ** 6n }) as never;
    const v = await vetToken(base({ deepLiquidity: true, maxRoundtripBps: 300 }), {
      fetchSafety: async () => [safe()],
      bestSwap: lossySwap,
    });
    expect(v.checks.liquidityFloor.ok).toBe(false);
    expect(v.verdict).toBe('reject');
  });

  it('Etapa 6 (deep): round-trip sem perda → liquidez ok → PASSA', async () => {
    const v = await vetToken(base({ deepLiquidity: true, maxRoundtripBps: 300 }), {
      fetchSafety: async () => [safe()],
      bestSwap: okSwap, // devolve o mesmo valor nos 2 sentidos → perda 0
    });
    expect(v.verdict).toBe('pass');
  });

  it('lock: reflete a flag do GoPlus (source goplus na Etapa 1)', async () => {
    const v = await vetToken(base(), { fetchSafety: async () => [safe({ topHolderIsLocked: true })], bestSwap: okSwap });
    expect(v.checks.lockStatus).toMatchObject({ locked: true, source: 'goplus' });
  });

  it('Tier 0: lock RICO do GoPlus (% travado + locker + vencimento)', async () => {
    const v = await vetToken(base(), {
      fetchSafety: async () => [safe({ lpLockedPct: 80, lpLockerTag: 'UniCrypt', lpUnlockAtSec: 1_893_456_000 })],
      bestSwap: okSwap,
    });
    expect(v.checks.lockStatus).toMatchObject({ locked: true, pctLocked: 80, locker: 'UniCrypt' });
    expect(v.checks.lockStatus.unlockIso).toContain('20'); // ex: 2030-...
  });
});
