/**
 * Bribe competitor-aware com teto de lucro (Motor 1 mainnet).
 * Invariante crítica: o líquido (lucro − baseFee*gas − priority*gas) NUNCA cai abaixo do piso.
 */
import { describe, expect, it } from 'vitest';
import { calculateCompetitiveBribe, BribeTracker, shouldAutoEnableCompetitiveBribe } from '../src/competitiveBribe';

describe('shouldAutoEnableCompetitiveBribe — gatilho do auto-liga (Motor 2)', () => {
  it('liga quando gas_outbid >= limiar', () => {
    expect(shouldAutoEnableCompetitiveBribe({ outbidCount: 3, threshold: 3 })).toBe(true);
    expect(shouldAutoEnableCompetitiveBribe({ outbidCount: 5, threshold: 3 })).toBe(true);
  });
  it('NÃO liga abaixo do limiar', () => {
    expect(shouldAutoEnableCompetitiveBribe({ outbidCount: 2, threshold: 3 })).toBe(false);
    expect(shouldAutoEnableCompetitiveBribe({ outbidCount: 0, threshold: 3 })).toBe(false);
  });
  it('valores inválidos → não liga (fail-safe)', () => {
    expect(shouldAutoEnableCompetitiveBribe({ outbidCount: NaN, threshold: 3 })).toBe(false);
    expect(shouldAutoEnableCompetitiveBribe({ outbidCount: 5, threshold: 0 })).toBe(false);
  });
});

const gwei = (n: number) => BigInt(Math.floor(n * 1e9));
const GAS = 300_000n;

// Helper: líquido resultante (wei) dado o priority retornado.
function netWei(expectedProfit: bigint, baseFee: bigint, priority: bigint) {
  return expectedProfit - (baseFee + priority) * GAS;
}

describe('calculateCompetitiveBribe — teto de lucro', () => {
  const base = {
    gasUnits: GAS,
    baseFeePerGasWei: gwei(0.01),
    basePriorityFeeWei: gwei(0.001),
    minProfitWei: gwei(0.5), // piso de lucro ~0.5 gwei*? (em ETH-wei só importa a relação)
  };

  it('alvo cabe no lucro → sobe pra ganhar (raised-to-market) e segue lucrando', () => {
    const r = calculateCompetitiveBribe({
      ...base,
      expectedProfitWei: gwei(1_000_000), // lucro alto
      marketTargetPriorityFeeWei: gwei(0.42), // p75
    });
    expect(r.priorityFeeWei).toBe(gwei(0.42));
    expect(r.autoRaised).toBe(true);
    expect(r.reason).toBe('raised-to-market');
    expect(netWei(gwei(1_000_000), base.baseFeePerGasWei, r.priorityFeeWei)).toBeGreaterThan(base.minProfitWei);
  });

  it('alvo NÃO cabe → limita pelo lucro (capped-by-profit) e NUNCA fica abaixo do piso', () => {
    // lucro apertado: só dá pra pagar um priority pequeno mantendo o piso
    const expectedProfit = base.baseFeePerGasWei * GAS + base.minProfitWei + gwei(0.05) * GAS; // headroom = 0.05 gwei/gas
    const r = calculateCompetitiveBribe({
      ...base,
      expectedProfitWei: expectedProfit,
      marketTargetPriorityFeeWei: gwei(1.3), // mercado quer MUITO mais do que cabe
    });
    expect(r.reason).toBe('capped-by-profit');
    expect(r.priorityFeeWei).toBeLessThan(gwei(1.3)); // não overbid
    // líquido continua >= piso (nunca prejuízo)
    expect(netWei(expectedProfit, base.baseFeePerGasWei, r.priorityFeeWei)).toBeGreaterThanOrEqual(base.minProfitWei - 1n);
  });

  it('mercado abaixo do nosso base → fica no base (sem auto-raise)', () => {
    const r = calculateCompetitiveBribe({
      ...base,
      expectedProfitWei: gwei(1_000_000),
      marketTargetPriorityFeeWei: gwei(0.0005), // abaixo do base 0.001
    });
    expect(r.priorityFeeWei).toBe(base.basePriorityFeeWei);
    expect(r.autoRaised).toBe(false);
    expect(r.reason).toBe('base');
  });

  it('lucro <= piso (sem headroom) → fica no base (EV gate / contrato cuidam)', () => {
    const r = calculateCompetitiveBribe({
      ...base,
      expectedProfitWei: base.baseFeePerGasWei * GAS, // sobra 0 pra priority
      marketTargetPriorityFeeWei: gwei(0.42),
    });
    expect(r.priorityFeeWei).toBe(base.basePriorityFeeWei);
    expect(r.autoRaised).toBe(false);
  });

  it('respeita o teto rígido de segurança (maxPriorityFeeWei)', () => {
    const r = calculateCompetitiveBribe({
      ...base,
      expectedProfitWei: gwei(1_000_000),
      marketTargetPriorityFeeWei: gwei(5), // mercado altíssimo
      maxPriorityFeeWei: gwei(0.5), // teto rígido
    });
    expect(r.priorityFeeWei).toBe(gwei(0.5));
  });

  it('gasUnits=0 → base (sem divisão por zero)', () => {
    const r = calculateCompetitiveBribe({ ...base, gasUnits: 0n, expectedProfitWei: gwei(1_000_000), marketTargetPriorityFeeWei: gwei(0.42) });
    expect(r.priorityFeeWei).toBe(base.basePriorityFeeWei);
  });
});

describe('BribeTracker', () => {
  it('guarda o último bribe efetivo + auto-raise; ignora inválidos', () => {
    const t = new BribeTracker();
    expect(t.stats()).toBeNull();
    t.observe(0.42, true, 'raised-to-market');
    expect(t.stats()).toMatchObject({ lastGwei: 0.42, autoRaised: true, reason: 'raised-to-market' });
    t.observe(NaN, true, 'base');
    expect(t.stats()?.lastGwei).toBe(0.42); // inválido ignorado
  });
});
