/**
 * DimensionMetricsExporter — bridge ledger DuckDB → Prometheus (OIE Etapa D, parte 2).
 *
 * O Grafana não lê DuckDB nativamente. Este exporter roda IN-PROCESS no app que tem o
 * ledger (detector/MIS), consulta os rankings (`queryDimensionStats`/`queryTopOpportunityPairs`)
 * a cada N minutos e seta métricas custom no `MetricRegistry` existente — que o health server
 * já expõe em `/metrics`. Assim o Grafana lê os dados de observação via Prometheus. Zero infra nova.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

import type { TimeseriesStore } from '../intelligence/timeseriesStore';
import { queryTopOpportunityPairs } from '../intelligence/observation';
import { queryDimensionStats } from '../scoring/dimensionStatsQuery';
import { rankDimension, type Dimension } from '../scoring/dimensionScorer';
import { MetricRegistry, type MetricDefinition } from './prometheusExporter';

const DIMENSIONS: Dimension[] = ['protocol', 'pool', 'token'];

/** Métricas custom de ranking de observação (todas gauge). */
export const DIMENSION_METRICS: MetricDefinition[] = [
  { name: 'zeus_dim_score', help: 'OIE dimension score [0,1] por dimensão/chave', type: 'gauge', labels: ['dimension', 'key', 'chain'] },
  { name: 'zeus_dim_observations', help: 'Total de ops observadas por dimensão/chave', type: 'gauge', labels: ['dimension', 'key', 'chain'] },
  { name: 'zeus_dim_net_profit_usd', help: 'Lucro líquido médio (USD) por dimensão/chave', type: 'gauge', labels: ['dimension', 'key', 'chain'] },
  { name: 'zeus_pair_observations', help: 'Observações por par', type: 'gauge', labels: ['pair', 'protocol', 'chain'] },
  { name: 'zeus_pair_avg_profit_usd', help: 'Lucro médio observado (USD) por par', type: 'gauge', labels: ['pair', 'protocol', 'chain'] },
  { name: 'zeus_pair_persistence_hours', help: 'Persistência (horas ativas) por par', type: 'gauge', labels: ['pair', 'protocol', 'chain'] },
];

export function defineDimensionMetrics(registry: MetricRegistry): void {
  for (const def of DIMENSION_METRICS) registry.define(def);
}

export interface DimensionMetricsExporterOpts {
  registry: MetricRegistry;
  store: TimeseriesStore;
  chain: string;
  /** Janela de agregação. Default 7 dias. */
  windowMs?: number;
  /** Intervalo de refresh. Default 5 min. */
  intervalMs?: number;
  logger?: LoggerLike;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class DimensionMetricsExporter {
  private readonly registry: MetricRegistry;
  private readonly store: TimeseriesStore;
  private readonly chain: string;
  private readonly windowMs: number;
  private readonly intervalMs: number;
  private readonly logger: LoggerLike | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: DimensionMetricsExporterOpts) {
    this.registry = opts.registry;
    this.store = opts.store;
    this.chain = opts.chain;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = opts.logger;
    defineDimensionMetrics(this.registry);
  }

  /** Roda uma atualização das métricas a partir do ledger. */
  async updateOnce(): Promise<void> {
    const opts = { windowMs: this.windowMs, chain: this.chain };

    for (const dim of DIMENSIONS) {
      const stats = await queryDimensionStats(this.store, dim, opts);
      for (const s of rankDimension(dim, stats, { windowMs: this.windowMs })) {
        const labels = { dimension: dim, key: s.key, chain: this.chain };
        this.registry.set('zeus_dim_score', s.score, labels);
        this.registry.set('zeus_dim_observations', s.raw.total_ops, labels);
        this.registry.set('zeus_dim_net_profit_usd', s.raw.avg_net_usd, labels);
      }
    }

    for (const p of await queryTopOpportunityPairs(this.store, opts)) {
      const labels = { pair: p.pair, protocol: p.protocol ?? 'unknown', chain: this.chain };
      this.registry.set('zeus_pair_observations', p.observations, labels);
      this.registry.set('zeus_pair_avg_profit_usd', p.avg_profit_usd, labels);
      this.registry.set('zeus_pair_persistence_hours', p.active_hours, labels);
    }
  }

  /** Começa o refresh periódico (não bloqueia o processo de sair). */
  start(): void {
    if (this.timer) return;
    void this.updateOnce().catch((err) =>
      this.logger?.warn({ err: err instanceof Error ? err.message : err }, 'DimensionMetricsExporter: update inicial falhou'),
    );
    this.timer = setInterval(() => {
      void this.updateOnce().catch((err) =>
        this.logger?.warn({ err: err instanceof Error ? err.message : err }, 'DimensionMetricsExporter: update falhou'),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
