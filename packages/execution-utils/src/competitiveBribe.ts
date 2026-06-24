/**
 * Bribe competitor-aware com TETO DE LUCRO (Motor 1 mainnet).
 *
 * Doutrina do Humberto: lucrar SEMPRE, nem que pouco — nunca sair no prejuízo. O bribe (priority fee
 * na Base) sobe o quanto for preciso pra ganhar a corrida, MAS jamais além do ponto onde o líquido
 * (lucro − baseFee − priority) cairia abaixo de um piso mínimo. Se cabe no lucro → paga e ganha
 * (dinheiro na mesa = nosso). Se não cabe → paga só até onde ainda lucra (não overbid pro prejuízo).
 *
 * 100% em WEI (termos de ETH). O caller converte o lucro do ativo → ETH-wei antes de chamar.
 * Backstop final é on-chain (`minProfitWei` no contrato reverte se o líquido não fechar) — isto é a
 * camada de COMPETITIVIDADE off-chain; defesa em profundidade.
 */

export type BribeAdjustReason = 'base' | 'raised-to-market' | 'capped-by-profit';

export interface CompetitiveBribeResult {
  /** Priority fee a usar (wei por unidade de gás). */
  priorityFeeWei: bigint;
  /** true se subiu acima do nosso lance-base (auto-ajuste por competição). */
  autoRaised: boolean;
  /** Por que ficou nesse valor (pro painel explicar o auto-ajuste). */
  reason: BribeAdjustReason;
}

export interface CompetitiveBribeInput {
  /** Lucro BRUTO esperado da operação, em ETH-wei (caller converte do ativo). */
  expectedProfitWei: bigint;
  /** Unidades de gás estimadas da tx. */
  gasUnits: bigint;
  /** baseFee atual (wei/gás) — inevitável, queimado. */
  baseFeePerGasWei: bigint;
  /** Nosso lance-base configurado (wei/gás) — piso (nunca abaixo disso). */
  basePriorityFeeWei: bigint;
  /** Alvo competitivo pra ganhar a corrida (wei/gás) — ex.: p75/p95 do mercado. */
  marketTargetPriorityFeeWei: bigint;
  /** Lucro líquido mínimo que insistimos em manter, em ETH-wei (piso; ≥ 0). */
  minProfitWei: bigint;
  /** Teto rígido de segurança (wei/gás), opcional — sanidade extra além do teto de lucro. */
  maxPriorityFeeWei?: bigint;
}

/**
 * Calcula o priority fee competitivo limitado por lucro. Determinístico, sem efeitos colaterais.
 */
export function calculateCompetitiveBribe(input: CompetitiveBribeInput): CompetitiveBribeResult {
  const {
    expectedProfitWei,
    gasUnits,
    baseFeePerGasWei,
    basePriorityFeeWei,
    marketTargetPriorityFeeWei,
    minProfitWei,
    maxPriorityFeeWei,
  } = input;

  // Sem gás estimado não dá pra raciocinar por unidade — fica no base (seguro).
  if (gasUnits <= 0n) {
    return { priorityFeeWei: basePriorityFeeWei, autoRaised: false, reason: 'base' };
  }

  // Teto de LUCRO: o máximo de priority/gás que ainda mantém o líquido ≥ piso.
  //   líquido = expectedProfit − baseFee*gas − priority*gas ≥ minProfit
  //   ⇒ priority ≤ (expectedProfit − minProfit − baseFee*gas) / gas
  const baseGasCost = baseFeePerGasWei * gasUnits;
  const headroomTotal = expectedProfitWei - minProfitWei - baseGasCost; // o que sobra pra priority (total)
  const maxAffordablePerGas = headroomTotal > 0n ? headroomTotal / gasUnits : 0n;

  // Alvo competitivo: o que precisa pra ganhar, nunca abaixo do nosso base; respeita teto rígido.
  let target =
    marketTargetPriorityFeeWei > basePriorityFeeWei ? marketTargetPriorityFeeWei : basePriorityFeeWei;
  if (maxPriorityFeeWei != null && maxPriorityFeeWei > 0n && target > maxPriorityFeeWei) {
    target = maxPriorityFeeWei;
  }

  let effective: bigint;
  let reason: BribeAdjustReason;

  if (target <= maxAffordablePerGas) {
    // Cabe no lucro: paga o alvo (ganha a corrida E continua lucrando).
    effective = target;
    reason = target > basePriorityFeeWei ? 'raised-to-market' : 'base';
  } else {
    // Não cabe: paga só até onde ainda lucra (nunca overbid pro prejuízo).
    effective = maxAffordablePerGas > basePriorityFeeWei ? maxAffordablePerGas : basePriorityFeeWei;
    reason = effective > basePriorityFeeWei ? 'capped-by-profit' : 'base';
  }

  // Nunca abaixo do base, nunca negativo.
  if (effective < basePriorityFeeWei) effective = basePriorityFeeWei;
  if (effective < 0n) effective = 0n;

  return { priorityFeeWei: effective, autoRaised: effective > basePriorityFeeWei, reason };
}

/**
 * Tracker do último bribe efetivo (pro heartbeat → painel). Guarda o valor em gwei + se auto-ajustou.
 */
export interface BribeState {
  lastGwei: number;
  autoRaised: boolean;
  reason: BribeAdjustReason;
}

export class BribeTracker {
  private state: BribeState | null = null;

  observe(gwei: number, autoRaised: boolean, reason: BribeAdjustReason): void {
    if (!Number.isFinite(gwei) || gwei < 0) return;
    this.state = { lastGwei: gwei, autoRaised, reason };
  }

  /** Último bribe efetivo, ou null se ainda não despachou nada. */
  stats(): BribeState | null {
    return this.state ? { ...this.state } : null;
  }
}
