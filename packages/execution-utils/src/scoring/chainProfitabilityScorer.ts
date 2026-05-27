/**
 * ChainProfitabilityScorer — Doutrina ZEUS (decidido 2026-05-27).
 *
 * Calcula score 0-1 por (chain, protocol) combo pra decidir onde concentrar capital
 * APÓS o DRY_RUN comparativo de 14 dias.
 *
 * Fórmula (decidida com Humberto):
 *   score =
 *       opportunity_density   × 0.25
 *     + expected_win_rate     × 0.30
 *     + net_profitability     × 0.30
 *     - competition_intensity × 0.15
 *
 * Todos os 4 termos são normalizados pra [0, 1] antes de aplicar o peso.
 *
 * Filosofia:
 *   - Stateless: consome dados de componentes existentes (zero duplicação de state)
 *   - Multi-chain native: chama por (chain, protocol)
 *   - Logging-first: emite log/Prometheus, NÃO age automaticamente (humano decide)
 *
 * Mapeamento de dados:
 *   opportunity_density   ← intelligenceStore (DuckDB) ou observation counter
 *   expected_win_rate     ← pnlReconciler.stats() (confirmed / totalReconciliations)
 *   net_profitability     ← pnlReconciler.stats().realizedTotalUsd / total
 *   competition_intensity ← senderRegistry.size() em janela + gas premium nosso
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

import type { PnlReconciler } from '../pnl/pnlReconciler';
import type { SenderRegistry } from '../competitors/senderRegistry';

// ─── Pesos da fórmula (constantes pra reprodutibilidade) ───
export const SCORE_WEIGHTS = {
  opportunity_density: 0.25,
  expected_win_rate: 0.30,
  net_profitability: 0.30,
  competition_intensity: 0.15,
} as const;

// ─── Normalizers (mapeiam absoluto → [0,1]) ───
// Calibrar após primeiros 14d de DRY_RUN com dados reais.
const NORMALIZE = {
  /** ops/hora → 1.0 = "mercado quente" (10+ ops/hora). */
  opportunity_density_max: 10,
  /** lucro USD médio por op → 1.0 = $50+. */
  net_profitability_max: 50,
  /** competitors únicos vistos → 1.0 = 50+ (saturação). */
  competition_intensity_max: 50,
} as const;

export interface ScoreComponents {
  opportunity_density: number;        // [0,1] — densidade de oportunidades
  expected_win_rate: number;          // [0,1] — confirmed / total
  net_profitability: number;          // [0,1] — lucro médio por op normalizado
  competition_intensity: number;      // [0,1] — quantos competidores ativos
}

export interface ChainScore {
  chain: string;
  protocol: string;
  /** Score final [0,1] — mais alto = melhor lugar pra concentrar capital. */
  score: number;
  components: ScoreComponents;
  /** Valores absolutos (não normalizados) pra debug humano. */
  raw: {
    ops_per_hour: number;
    win_rate: number;
    avg_net_usd: number;
    unique_competitors: number;
    total_observations: number;
  };
  computed_at: number;
}

export interface ChainProfitabilityScorerOpts {
  pnlReconciler?: PnlReconciler;
  senderRegistry?: SenderRegistry;
  /** Janela de análise em ms. Default 7 dias. */
  windowMs?: number;
  logger?: LoggerLike;
}

export interface ChainObservation {
  chain: string;
  protocol: string;
  /** Quantas oportunidades foram vistas (descoberta retornou positions). */
  opportunities_seen?: number;
  /** Override manual de competidores únicos (senão usa senderRegistry.size). */
  unique_competitors?: number;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Scorer stateful — acumula observações de oportunidades por combo (chain, protocol)
 * e calcula score sob demanda.
 */
export class ChainProfitabilityScorer {
  private readonly windowMs: number;
  private readonly logger: LoggerLike | undefined;
  private readonly pnlReconciler: PnlReconciler | undefined;
  private readonly senderRegistry: SenderRegistry | undefined;

  /** Map "chain|protocol" → array de timestamps de observações. */
  private observations = new Map<string, number[]>();

  constructor(opts: ChainProfitabilityScorerOpts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.logger = opts.logger;
    this.pnlReconciler = opts.pnlReconciler;
    this.senderRegistry = opts.senderRegistry;
  }

  /**
   * Registra observação de oportunidade. Chamar quando discovery retorna positions.
   * Pode passar `opportunities_seen > 1` pra batch.
   */
  observe(obs: ChainObservation): void {
    const key = this._key(obs.chain, obs.protocol);
    const list = this.observations.get(key) ?? [];
    const now = Date.now();
    const count = obs.opportunities_seen ?? 1;
    for (let i = 0; i < count; i++) list.push(now);
    this.observations.set(key, list);
    this._prune(list);
  }

  /**
   * Calcula score pra um combo específico.
   * Retorna null se não houver dados suficientes (mínimo 5 observações).
   */
  scoreFor(chain: string, protocol: string): ChainScore | null {
    const key = this._key(chain, protocol);
    const obs = this.observations.get(key) ?? [];
    this._prune(obs);

    if (obs.length < 5) return null;

    const components = this._computeComponents(chain, protocol, obs);
    const raw = this._computeRaw(chain, protocol, obs);

    const score = Math.max(0, Math.min(1,
      components.opportunity_density * SCORE_WEIGHTS.opportunity_density
      + components.expected_win_rate * SCORE_WEIGHTS.expected_win_rate
      + components.net_profitability * SCORE_WEIGHTS.net_profitability
      - components.competition_intensity * SCORE_WEIGHTS.competition_intensity,
    ));

    return {
      chain,
      protocol,
      score: Math.round(score * 1000) / 1000,
      components,
      raw,
      computed_at: Date.now(),
    };
  }

  /**
   * Calcula scores pra TODOS os combos observados. Ordena por score desc
   * (vencedora primeiro — onde concentrar capital).
   */
  rankAll(): ChainScore[] {
    const scores: ChainScore[] = [];
    for (const key of this.observations.keys()) {
      const [chain, protocol] = key.split('|') as [string, string];
      const s = this.scoreFor(chain, protocol);
      if (s) scores.push(s);
    }
    return scores.sort((a, b) => b.score - a.score);
  }

  /**
   * Sumário stats globais.
   */
  stats(): { combos_tracked: number; total_observations: number; window_ms: number } {
    let total = 0;
    for (const list of this.observations.values()) total += list.length;
    return {
      combos_tracked: this.observations.size,
      total_observations: total,
      window_ms: this.windowMs,
    };
  }

  // ─── Internal ───

  private _key(chain: string, protocol: string): string {
    return `${chain.toLowerCase()}|${protocol.toLowerCase()}`;
  }

  private _prune(list: number[]): void {
    const cutoff = Date.now() - this.windowMs;
    while (list.length > 0 && (list[0] ?? 0) < cutoff) {
      list.shift();
    }
  }

  private _computeComponents(
    chain: string,
    protocol: string,
    obs: number[],
  ): ScoreComponents {
    // ── opportunity_density ──
    const hoursInWindow = this.windowMs / (60 * 60 * 1000);
    const opsPerHour = obs.length / hoursInWindow;
    const opportunity_density = Math.min(1, opsPerHour / NORMALIZE.opportunity_density_max);

    // ── expected_win_rate + net_profitability via pnlReconciler ──
    let expected_win_rate = 0.3; // fallback neutro
    let net_profitability = 0;
    if (this.pnlReconciler) {
      const stats = this.pnlReconciler.stats();
      if (stats.totalReconciliations > 0) {
        expected_win_rate = stats.withinNormalBandCount / stats.totalReconciliations;
        const avgNet = stats.realizedTotalUsd / stats.totalReconciliations;
        net_profitability = Math.max(0, Math.min(1, avgNet / NORMALIZE.net_profitability_max));
      }
    }

    // ── competition_intensity ──
    let unique_competitors = 0;
    if (this.senderRegistry) {
      unique_competitors = this.senderRegistry.stats().total_profiles;
    }
    const competition_intensity = Math.min(1, unique_competitors / NORMALIZE.competition_intensity_max);

    return {
      opportunity_density: Math.round(opportunity_density * 1000) / 1000,
      expected_win_rate: Math.round(expected_win_rate * 1000) / 1000,
      net_profitability: Math.round(net_profitability * 1000) / 1000,
      competition_intensity: Math.round(competition_intensity * 1000) / 1000,
    };
  }

  private _computeRaw(
    _chain: string,
    _protocol: string,
    obs: number[],
  ): ChainScore['raw'] {
    const hoursInWindow = this.windowMs / (60 * 60 * 1000);
    const ops_per_hour = obs.length / hoursInWindow;

    let win_rate = 0;
    let avg_net_usd = 0;
    if (this.pnlReconciler) {
      const stats = this.pnlReconciler.stats();
      if (stats.totalReconciliations > 0) {
        win_rate = stats.withinNormalBandCount / stats.totalReconciliations;
        avg_net_usd = stats.realizedTotalUsd / stats.totalReconciliations;
      }
    }

    const unique_competitors = this.senderRegistry?.stats().total_profiles ?? 0;

    return {
      ops_per_hour: Math.round(ops_per_hour * 100) / 100,
      win_rate: Math.round(win_rate * 1000) / 1000,
      avg_net_usd: Math.round(avg_net_usd * 100) / 100,
      unique_competitors,
      total_observations: obs.length,
    };
  }
}

/**
 * Formata ranking como Markdown pra Discord weekly digest.
 */
export function formatScoreRankingMarkdown(scores: ChainScore[]): string {
  if (scores.length === 0) {
    return '_Sem dados suficientes ainda (mínimo 5 obs por combo)._';
  }

  const lines: string[] = [];
  lines.push('## 🎯 Chain Profitability Ranking');
  lines.push('');
  lines.push('| # | Chain × Protocol | Score | Ops/h | Win% | $/op | Comp |');
  lines.push('|---|------------------|-------|-------|------|------|------|');

  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    lines.push(
      `| ${medal} | ${s.chain} × ${s.protocol} | ` +
      `**${s.score.toFixed(3)}** | ` +
      `${s.raw.ops_per_hour.toFixed(1)} | ` +
      `${(s.raw.win_rate * 100).toFixed(0)}% | ` +
      `$${s.raw.avg_net_usd.toFixed(1)} | ` +
      `${s.raw.unique_competitors} |`,
    );
  }

  lines.push('');
  lines.push('_Score: 0.25×density + 0.30×winRate + 0.30×profit − 0.15×competition_');

  if (scores.length > 0 && scores[0]!.score >= 0.6) {
    lines.push('');
    lines.push(`💡 **Recomendação:** concentrar capital em \`${scores[0]!.chain} × ${scores[0]!.protocol}\`.`);
  }

  return lines.join('\n');
}
