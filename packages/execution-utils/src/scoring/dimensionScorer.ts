/**
 * DimensionScorer — OIE Master Blueprint (Fases 2-3: Protocol / Pool / Token Score).
 *
 * Hoje só o `chain × protocol` combo é pontuado (ChainProfitabilityScorer). Sem score
 * por protocol/pool/token o bot trata todo pool e todo token igual — gasta gas onde não
 * paga. Este módulo agrega o histórico já gravado no DuckDB (`events` table) e pontua
 * cada valor de cada dimensão, deixando o bot **concentrar capital onde realmente paga**.
 *
 * Fórmulas do blueprint (cada termo normalizado pra [0,1] antes do peso):
 *   Protocol Score = Profitability + Opportunity Density + Win Rate − Competition
 *   Pool Score     = Spread Persistence + Liquidity Quality + Profitability − Competition
 *   Token Score    = Historical Profit + Frequency + Persistence − Competition
 *
 * Filosofia (igual ChainProfitabilityScorer):
 *   - Stateless: consome `DimensionStats[]` (agregados do DuckDB) — zero duplicação de state
 *   - Puro e determinístico → trivial de testar sem DuckDB
 *   - Logging-first: ranqueia, não age (humano/engine decide)
 *
 * A coleta dos agregados vive em `dimensionStatsQuery.ts` (SQL sobre TimeseriesStore).
 */

export type Dimension = 'protocol' | 'pool' | 'token';

/**
 * Agregados de uma dimensão (um protocol, um pool/par, ou um token) numa janela.
 * Produzido por `queryDimensionStats` a partir do DuckDB.
 */
export interface DimensionStats {
  /** Valor da dimensão: nome do protocol, par do pool ('USDC/WETH'), ou símbolo do token. */
  key: string;
  /** Total de eventos/oportunidades observados na janela. */
  total_ops: number;
  /** Confirmados (profit realizado): liquidation/backrun/arb. */
  successful_ops: number;
  /** Reverts on-chain. */
  failed_ops: number;
  /** Soma de (profit_usd − gas_usd) dos confirmados, em USD. */
  net_profit_usd: number;
  /** Competidores únicos (distinct sender) vistos na dimensão. */
  unique_competitors: number;
  /** Tamanho médio da operação em USD (proxy de liquidez/profundidade do pool). */
  avg_amount_usd?: number;
  /** Buckets de hora distintos em que a dimensão teve atividade (proxy de persistência). */
  active_hours?: number;
}

// ─── Normalizers (absoluto → [0,1]) ───
export const DIMENSION_NORMALIZE = {
  /** lucro líquido médio por op → 1.0 = $50+. */
  net_profitability_max: 50,
  /** ops/hora → 1.0 = 10+ ("dimensão quente"). */
  opportunity_density_max: 10,
  /** tamanho médio op → 1.0 = $100k+ (profundidade saudável). */
  liquidity_max_usd: 100_000,
  /** competidores únicos → 1.0 = 50+ (saturação). */
  competition_max: 50,
} as const;

export interface DimensionWeights {
  profitability: number;
  density: number;       // opportunity density / frequency
  win_rate: number;
  persistence: number;   // spread persistence (pool) / persistence (token)
  liquidity: number;     // liquidity quality (pool)
  competition: number;   // sempre subtraído
}

/**
 * Pesos por dimensão, fiéis às fórmulas do blueprint. Termos não usados ficam 0.
 * Em cada preset, os termos positivos somam ~1.0 (a competição é subtraída).
 */
export const DIMENSION_WEIGHTS: Record<Dimension, DimensionWeights> = {
  // Profitability + Opportunity Density + Win Rate − Competition
  protocol: { profitability: 0.35, density: 0.30, win_rate: 0.35, persistence: 0, liquidity: 0, competition: 0.20 },
  // Spread Persistence + Liquidity Quality + Profitability − Competition
  pool: { profitability: 0.35, density: 0, win_rate: 0, persistence: 0.35, liquidity: 0.30, competition: 0.15 },
  // Historical Profit + Frequency + Persistence − Competition
  token: { profitability: 0.35, density: 0.30, win_rate: 0, persistence: 0.35, liquidity: 0, competition: 0.20 },
};

export interface DimensionScoreComponents {
  profitability: number;
  density: number;
  win_rate: number;
  persistence: number;
  liquidity: number;
  competition: number;
}

export interface DimensionScore {
  dimension: Dimension;
  key: string;
  /** Score final [0,1] — mais alto = melhor lugar pra concentrar capital. */
  score: number;
  components: DimensionScoreComponents;
  raw: {
    ops_per_hour: number;
    win_rate: number;
    avg_net_usd: number;
    avg_amount_usd: number;
    unique_competitors: number;
    total_ops: number;
  };
  computed_at: number;
}

export interface DimensionScoreOpts {
  /** Janela usada na agregação, em ms. Default 7 dias (pra density/persistence). */
  windowMs?: number;
  /** Mínimo de ops pra pontuar (senão null). Default 5. */
  minOps?: number;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_OPS = 5;

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function computeComponents(
  stats: DimensionStats,
  windowMs: number,
): { components: DimensionScoreComponents; raw: DimensionScore['raw'] } {
  const hoursInWindow = windowMs / (60 * 60 * 1000);

  const opsPerHour = stats.total_ops / hoursInWindow;
  const density = clamp01(opsPerHour / DIMENSION_NORMALIZE.opportunity_density_max);

  const settled = stats.successful_ops + stats.failed_ops;
  const winRate = settled > 0 ? stats.successful_ops / settled : 0;

  const avgNetUsd = stats.successful_ops > 0
    ? stats.net_profit_usd / stats.successful_ops
    : 0;
  const profitability = clamp01(avgNetUsd / DIMENSION_NORMALIZE.net_profitability_max);

  const avgAmountUsd = stats.avg_amount_usd ?? 0;
  const liquidity = clamp01(avgAmountUsd / DIMENSION_NORMALIZE.liquidity_max_usd);

  // persistência = fração de horas ativas dentro da janela (cap 1.0)
  const persistence = clamp01((stats.active_hours ?? 0) / Math.max(1, hoursInWindow));

  const competition = clamp01(stats.unique_competitors / DIMENSION_NORMALIZE.competition_max);

  return {
    components: {
      profitability: round3(profitability),
      density: round3(density),
      win_rate: round3(winRate),
      persistence: round3(persistence),
      liquidity: round3(liquidity),
      competition: round3(competition),
    },
    raw: {
      ops_per_hour: Math.round(opsPerHour * 100) / 100,
      win_rate: round3(winRate),
      avg_net_usd: Math.round(avgNetUsd * 100) / 100,
      avg_amount_usd: Math.round(avgAmountUsd * 100) / 100,
      unique_competitors: stats.unique_competitors,
      total_ops: stats.total_ops,
    },
  };
}

/**
 * Pontua um valor de dimensão. Retorna null se < minOps observações.
 */
export function scoreDimension(
  dimension: Dimension,
  stats: DimensionStats,
  opts: DimensionScoreOpts = {},
): DimensionScore | null {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const minOps = opts.minOps ?? DEFAULT_MIN_OPS;

  if (stats.total_ops < minOps) return null;

  const { components, raw } = computeComponents(stats, windowMs);
  const w = DIMENSION_WEIGHTS[dimension];

  const score = clamp01(
    components.profitability * w.profitability
    + components.density * w.density
    + components.win_rate * w.win_rate
    + components.persistence * w.persistence
    + components.liquidity * w.liquidity
    - components.competition * w.competition,
  );

  return {
    dimension,
    key: stats.key,
    score: round3(score),
    components,
    raw,
    computed_at: Date.now(),
  };
}

/**
 * Pontua e ranqueia (score desc) todos os valores de uma dimensão.
 * Descarta os que não atingiram minOps.
 */
export function rankDimension(
  dimension: Dimension,
  statsList: DimensionStats[],
  opts: DimensionScoreOpts = {},
): DimensionScore[] {
  const scores: DimensionScore[] = [];
  for (const stats of statsList) {
    const s = scoreDimension(dimension, stats, opts);
    if (s) scores.push(s);
  }
  return scores.sort((a, b) => b.score - a.score);
}

/**
 * Formata ranking de uma dimensão como Markdown pra Discord digest.
 */
export function formatDimensionRankingMarkdown(
  dimension: Dimension,
  scores: DimensionScore[],
): string {
  const title = dimension.charAt(0).toUpperCase() + dimension.slice(1);
  if (scores.length === 0) {
    return `_${title} ranking: sem dados suficientes ainda._`;
  }

  const lines: string[] = [];
  lines.push(`## 🎯 ${title} Ranking`);
  lines.push('');
  lines.push(`| # | ${title} | Score | Ops/h | Win% | $/op | Comp |`);
  lines.push('|---|------|-------|-------|------|------|------|');

  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    lines.push(
      `| ${medal} | ${s.key} | ` +
      `**${s.score.toFixed(3)}** | ` +
      `${s.raw.ops_per_hour.toFixed(1)} | ` +
      `${(s.raw.win_rate * 100).toFixed(0)}% | ` +
      `$${s.raw.avg_net_usd.toFixed(1)} | ` +
      `${s.raw.unique_competitors} |`,
    );
  }

  return lines.join('\n');
}
