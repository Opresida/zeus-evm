/**
 * OpportunityScorer — OIE Master Blueprint (Fase 4 "Opportunity Score").
 *
 * Hoje os engines só têm um *gate* binário (passa/não passa o threshold). Quando N
 * oportunidades disputam o mesmo bloco/nonce/budget de gas, o bot não tem como escolher
 * a de maior valor esperado. Este módulo entrega o **primitivo de ranking** que faltava.
 *
 * Fórmula do blueprint:
 *   Opportunity Score = Expected Profit + Success Probability − Competition − Slippage − Gas Cost
 *
 * Duas saídas, com papéis distintos:
 *   - `evUsd`  → valor esperado ajustado a risco (P(sucesso) × lucro líquido). É a CHAVE
 *               DE ORDENAÇÃO sob contenção: o bot executa primeiro a de maior EV.
 *   - `score`  → composto normalizado [0,1] pra thresholds/dashboards/Grafana.
 *
 * Filosofia (igual ChainProfitabilityScorer):
 *   - Stateless e puro (mesma entrada → mesma saída; trivial de testar)
 *   - Zero acoplamento com protocolo (Aave/Compound/Morpho/UniV3/backrun)
 *   - Logging-first: não age sozinho, só ranqueia (engine decide)
 */

// ─── Pesos da fórmula universal (constantes pra reprodutibilidade) ───
export const OPPORTUNITY_WEIGHTS = {
  expected_profit: 0.40,
  success_probability: 0.35,
  competition: 0.15,
  slippage: 0.10,
} as const;

// ─── Normalizers (mapeiam absoluto → [0,1]) ───
// Calibrar após DRY_RUN com dados reais, igual ao ChainProfitabilityScorer.
export const OPPORTUNITY_NORMALIZE = {
  /** lucro líquido USD → 1.0 = $50+ (saturação). */
  net_profit_max: 50,
  /** slippage esperado → 1.0 = 100 bps (1%). */
  slippage_max_bps: 100,
} as const;

export interface OpportunityScoreInput {
  /** Lucro bruto esperado (do simulator/calculator), em USD. */
  expectedProfitUsd: number;
  /** Custo de gas estimado, em USD. */
  gasCostUsd: number;
  /** Bribe/coinbase transfer esperado (backrun/MEV), em USD. Default 0. */
  bribeUsd?: number;
  /** Probabilidade de sucesso [0,1] (win rate histórico do combo, stale-check, etc). */
  successProbability: number;
  /** Slippage esperado em bps. Default 0. */
  slippageBps?: number;
  /** Intensidade de competição [0,1] (ex.: ChainScore.components.competition_intensity). Default 0. */
  competitionIntensity?: number;
  /** Identificador opcional pra correlacionar no ledger/logs. */
  opportunityId?: string;
}

export interface OpportunityScoreComponents {
  expected_profit: number;     // [0,1] — lucro líquido normalizado
  success_probability: number; // [0,1] — passthrough do input
  competition: number;         // [0,1] — passthrough do input
  slippage: number;            // [0,1] — slippage normalizado
}

export interface OpportunityScore {
  /** Valor esperado ajustado a risco, em USD. CHAVE DE ORDENAÇÃO sob contenção. */
  evUsd: number;
  /** Lucro líquido esperado (bruto − gas − bribe), em USD (não ajustado a risco). */
  netProfitUsd: number;
  /** Score composto normalizado [0,1] pra thresholds/dashboards. */
  score: number;
  components: OpportunityScoreComponents;
  opportunityId: string | undefined;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Pontua uma oportunidade. Puro: mesma entrada → mesma saída.
 */
export function scoreOpportunity(input: OpportunityScoreInput): OpportunityScore {
  const bribeUsd = input.bribeUsd ?? 0;
  const slippageBps = input.slippageBps ?? 0;
  const competition = clamp01(input.competitionIntensity ?? 0);
  const successProbability = clamp01(input.successProbability);

  const netProfitUsd = input.expectedProfitUsd - input.gasCostUsd - bribeUsd;
  const evUsd = successProbability * netProfitUsd;

  const profitNorm = clamp01(netProfitUsd / OPPORTUNITY_NORMALIZE.net_profit_max);
  const slippageNorm = clamp01(slippageBps / OPPORTUNITY_NORMALIZE.slippage_max_bps);

  const score = clamp01(
    profitNorm * OPPORTUNITY_WEIGHTS.expected_profit
    + successProbability * OPPORTUNITY_WEIGHTS.success_probability
    - competition * OPPORTUNITY_WEIGHTS.competition
    - slippageNorm * OPPORTUNITY_WEIGHTS.slippage,
  );

  return {
    evUsd: Math.round(evUsd * 100) / 100,
    netProfitUsd: Math.round(netProfitUsd * 100) / 100,
    score: round3(score),
    components: {
      expected_profit: round3(profitNorm),
      success_probability: round3(successProbability),
      competition: round3(competition),
      slippage: round3(slippageNorm),
    },
    opportunityId: input.opportunityId,
  };
}

export interface RankedOpportunity<T> {
  item: T;
  opportunity: OpportunityScore;
}

/**
 * Ranqueia uma lista de candidatos por EV (desc). Sob contenção, o primeiro vence.
 * `extract` mapeia cada item pros inputs de score.
 */
export function rankOpportunities<T>(
  items: T[],
  extract: (item: T) => OpportunityScoreInput,
): RankedOpportunity<T>[] {
  return items
    .map((item) => ({ item, opportunity: scoreOpportunity(extract(item)) }))
    .sort((a, b) => b.opportunity.evUsd - a.opportunity.evUsd);
}
