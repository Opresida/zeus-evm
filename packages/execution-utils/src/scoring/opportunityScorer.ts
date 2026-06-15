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

/**
 * Nível de gas war (competição no mempool). Espelha o tipo do backrun-engine sem
 * acoplar o pacote ao app (string union estável).
 */
export type GasWarLevel = 'normal' | 'elevated' | 'war';

/**
 * Priors competitor-aware por nível de gas war. Mapeiam a competição observada
 * em (intensidade [0,1], probabilidade de ganhar a corrida).
 *
 * Racional: numa "war", mesmo um backrun lucrativo tem baixa chance de ser
 * incluído (vários bots disputam) — o EV ajustado a risco captura isso e evita
 * gastar gas em corrida perdida. Calibrar com win-rate real pós-DRY_RUN.
 */
export const GAS_WAR_PRIORS: Record<GasWarLevel, { competition: number; successProbability: number }> = {
  normal: { competition: 0.20, successProbability: 0.85 },
  elevated: { competition: 0.50, successProbability: 0.60 },
  war: { competition: 0.85, successProbability: 0.35 },
} as const;

export interface BackrunOpportunityScoreInput {
  /** Lucro bruto esperado, USD. */
  profitUsd: number;
  /** Custo de gas estimado, USD. */
  gasUsd: number;
  /** Bribe/coinbase esperado, USD. Default 0. */
  bribeUsd?: number;
  /** Slippage esperado em bps. Default 0. */
  slippageBps?: number;
  /** Nível de gas war (competição). Default 'normal'. */
  gasWarLevel?: GasWarLevel;
  opportunityId?: string;
}

/**
 * Pontua uma oportunidade de backrun usando os priors competitor-aware do gas war.
 * Atalho sobre `scoreOpportunity` que deriva successProbability/competition do nível.
 */
export function scoreBackrunOpportunity(input: BackrunOpportunityScoreInput): OpportunityScore {
  const prior = GAS_WAR_PRIORS[input.gasWarLevel ?? 'normal'];
  return scoreOpportunity({
    expectedProfitUsd: input.profitUsd,
    gasCostUsd: input.gasUsd,
    bribeUsd: input.bribeUsd ?? 0,
    successProbability: prior.successProbability,
    slippageBps: input.slippageBps ?? 0,
    competitionIntensity: prior.competition,
    opportunityId: input.opportunityId,
  });
}

/**
 * OEV recapture priors por protocolo (fração [0,1] do valor da liquidação capturada
 * pelo PROTOCOLO via OEV auction / MEV tax / Chainlink SVR — ou seja, NÃO sobra pro
 * liquidador externo). Baseado na pesquisa de mercado (ver docs/refs/competitive-landscape.md,
 * 2026-06): liquidação na Base está se fechando por OEV capture, exceto Morpho Blue.
 *
 * Efeito prático: o lucro "realista" de uma liquidação = profit nominal × (1 − recapture).
 * Isso faz o bot PRIORIZAR Morpho (edge inteiro) e descartar Aave/Compound/Moonwell quando
 * o que sobra não paga gas+risco. Valores são DEFAULTS calibráveis — ajustar com dado real.
 */
export const OEV_RECAPTURE_PRIORS: Record<string, number> = {
  morpho: 0.0,    // aberto/permissionless — LIF inteiro pro liquidador
  aave: 0.85,     // Chainlink SVR live na Base (~80-90% recapturado)
  compound: 0.85, // SVR/Atlas live
  moonwell: 0.99, // MEV tax / OEV auction on-chain (fev/2025)
} as const;

/**
 * Resolve o recapture OEV a partir do label do protocolo. Forks de Aave (ex.: Seamless)
 * NÃO têm SVR por padrão → tratados como abertos (0). Desconhecido → 0 (não penaliza).
 */
export function oevRecaptureFor(protocol: string): number {
  const p = protocol.toLowerCase();
  if (p.includes('morpho')) return OEV_RECAPTURE_PRIORS.morpho!;
  if (p.includes('moonwell')) return OEV_RECAPTURE_PRIORS.moonwell!;
  if (p.includes('compound')) return OEV_RECAPTURE_PRIORS.compound!;
  // Só o core Aave V3 tem SVR; forks (labels sem "aave") ficam abertos (0).
  if (p === 'aave-v3' || p === 'aave' || p.startsWith('aave-v3')) return OEV_RECAPTURE_PRIORS.aave!;
  return 0;
}

export interface LiquidationOpportunityScoreInput {
  /** Lucro bruto esperado (bônus nominal), USD. */
  profitUsd: number;
  /** Custo de gas estimado, USD. */
  gasUsd: number;
  /** Label do protocolo: 'aave-v3', 'compound-v3', 'morpho-blue', 'moonwell', forks. */
  protocol: string;
  /** Slippage esperado em bps. Default 0. */
  slippageBps?: number;
  /** Intensidade de competição [0,1] (ex.: senderRegistry). Default 0. */
  competitionIntensity?: number;
  /** Probabilidade de sucesso [0,1]. Default 0.7 (liquidação depende de descoberta+ser 1º). */
  successProbability?: number;
  /** Força um recapture específico [0,1] (calibração). Senão usa o prior do protocolo. */
  oevRecaptureOverride?: number;
  opportunityId?: string;
}

export interface LiquidationOpportunityScore extends OpportunityScore {
  /** Fração [0,1] do valor capturada por OEV (não sobra pro liquidador). */
  oevRecapture: number;
  /** Lucro realista pós-OEV usado no score = profitUsd × (1 − recapture). */
  edgeAdjustedProfitUsd: number;
}

/**
 * Pontua uma oportunidade de liquidação aplicando o "OEV haircut" do protocolo.
 * O score/EV refletem o lucro REALISTA pós-OEV — não o bônus nominal — então Morpho
 * (recapture 0) domina Aave/Compound/Moonwell naturalmente no ranking.
 */
export function scoreLiquidationOpportunity(
  input: LiquidationOpportunityScoreInput,
): LiquidationOpportunityScore {
  const recapture = input.oevRecaptureOverride ?? oevRecaptureFor(input.protocol);
  const edgeAdjustedProfitUsd = input.profitUsd * (1 - recapture);
  const score = scoreOpportunity({
    expectedProfitUsd: edgeAdjustedProfitUsd,
    gasCostUsd: input.gasUsd,
    successProbability: input.successProbability ?? 0.7,
    slippageBps: input.slippageBps ?? 0,
    competitionIntensity: input.competitionIntensity ?? 0,
    opportunityId: input.opportunityId,
  });
  return {
    ...score,
    oevRecapture: recapture,
    edgeAdjustedProfitUsd: Math.round(edgeAdjustedProfitUsd * 100) / 100,
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
