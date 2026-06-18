/**
 * PrometheusExporter — Item 16B OB2 do checklist.
 *
 * Implementação minimalista do protocolo Prometheus text exposition format.
 * Não usa `prom-client` (peso de ~100kb) — produz output text diretamente.
 *
 * Aceita métricas registradas via `MetricRegistry` (counter/gauge/histogram).
 *
 * **Por que sem prom-client:**
 *  - Adiciona deps + complexidade
 *  - Performance overhead em hot path (escolha sintática vs perf direto)
 *  - Pra MVP, o `text exposition format` é trivial de implementar (~150 linhas)
 *
 * Quando crescer, swap pra prom-client é trivial (mesma interface).
 *
 * Output exemplo (formato Prometheus):
 * ```
 * # HELP zeus_operations_total Total operations by chain/protocol
 * # TYPE zeus_operations_total counter
 * zeus_operations_total{chain="Base",protocol="aave-v3"} 47
 *
 * # HELP zeus_pnl_realized_usd Realized PnL in USD
 * # TYPE zeus_pnl_realized_usd gauge
 * zeus_pnl_realized_usd{chain="Base"} 234.56
 * ```
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  /** Labels esperadas pra esta métrica (validação opcional). */
  labels?: string[];
}

interface MetricValue {
  value: number;
  labels: Record<string, string>;
}

interface HistogramBucket {
  le: number;
  count: number;
}

interface HistogramData {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
  labels: Record<string, string>;
}

/**
 * Registry centralizado de métricas. Coleta valores em memória, expõe
 * via `render()` em formato Prometheus text.
 */
export class MetricRegistry {
  private definitions = new Map<string, MetricDefinition>();
  private values = new Map<string, MetricValue[]>();
  private histograms = new Map<string, HistogramData[]>();
  private readonly logger: LoggerLike | undefined;

  constructor(opts: { logger?: LoggerLike } = {}) {
    this.logger = opts.logger;
  }

  /**
   * Define uma métrica. Idempotente.
   */
  define(def: MetricDefinition): void {
    this.definitions.set(def.name, def);
  }

  /**
   * Incrementa counter (default +1).
   */
  inc(name: string, labels: Record<string, string> = {}, delta = 1): void {
    const def = this.definitions.get(name);
    if (!def) {
      this.logger?.debug({ name }, 'MetricRegistry: counter não definido');
      return;
    }
    if (def.type !== 'counter') {
      this.logger?.warn({ name, type: def.type }, 'inc() só pra counter');
      return;
    }
    const entries = this.values.get(name) ?? [];
    const existing = entries.find((e) => sameLabels(e.labels, labels));
    if (existing) {
      existing.value += delta;
    } else {
      entries.push({ value: delta, labels });
      this.values.set(name, entries);
    }
  }

  /**
   * Seta gauge (substitui valor anterior).
   */
  set(name: string, value: number, labels: Record<string, string> = {}): void {
    const def = this.definitions.get(name);
    if (!def) return;
    if (def.type !== 'gauge') {
      this.logger?.warn({ name, type: def.type }, 'set() só pra gauge');
      return;
    }
    const entries = this.values.get(name) ?? [];
    const existing = entries.find((e) => sameLabels(e.labels, labels));
    if (existing) {
      existing.value = value;
    } else {
      entries.push({ value, labels });
      this.values.set(name, entries);
    }
  }

  /**
   * Observa valor pra histogram (cumulative buckets).
   * Bucket boundaries são fixados pela primeira observe ou via `defineHistogram`.
   */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const def = this.definitions.get(name);
    if (!def) return;
    if (def.type !== 'histogram') {
      this.logger?.warn({ name, type: def.type }, 'observe() só pra histogram');
      return;
    }

    const entries = this.histograms.get(name) ?? [];
    let hist = entries.find((h) => sameLabels(h.labels, labels));
    if (!hist) {
      // Default buckets exponenciais (Prometheus default): 5ms até 10s
      const defaultBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Infinity];
      hist = {
        labels,
        buckets: defaultBuckets.map((le) => ({ le, count: 0 })),
        sum: 0,
        count: 0,
      };
      entries.push(hist);
      this.histograms.set(name, entries);
    }

    hist.sum += value;
    hist.count++;
    for (const bucket of hist.buckets) {
      if (value <= bucket.le) bucket.count++;
    }
  }

  /**
   * Renderiza todas métricas em formato Prometheus text exposition.
   * Output pronto pra GET /metrics.
   */
  render(): string {
    const lines: string[] = [];

    for (const [name, def] of this.definitions.entries()) {
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} ${def.type}`);

      if (def.type === 'histogram') {
        const entries = this.histograms.get(name) ?? [];
        for (const hist of entries) {
          const labelStr = formatLabels(hist.labels);
          for (const bucket of hist.buckets) {
            const leLabel = bucket.le === Infinity ? '+Inf' : bucket.le.toString();
            const bucketLabels = labelStr
              ? labelStr.slice(0, -1) + `,le="${leLabel}"}`
              : `{le="${leLabel}"}`;
            lines.push(`${name}_bucket${bucketLabels} ${bucket.count}`);
          }
          lines.push(`${name}_sum${labelStr} ${hist.sum}`);
          lines.push(`${name}_count${labelStr} ${hist.count}`);
        }
      } else {
        const entries = this.values.get(name) ?? [];
        for (const entry of entries) {
          const labelStr = formatLabels(entry.labels);
          lines.push(`${name}${labelStr} ${entry.value}`);
        }
      }
      lines.push(''); // linha em branco entre métricas
    }

    return lines.join('\n');
  }

  /**
   * Limpa todos valores (útil em testes).
   */
  reset(): void {
    this.values.clear();
    this.histograms.clear();
  }

  /**
   * Stats agregados.
   */
  stats(): { definitions: number; counters: number; gauges: number; histograms: number } {
    let counters = 0, gauges = 0, histograms = 0;
    for (const def of this.definitions.values()) {
      if (def.type === 'counter') counters++;
      else if (def.type === 'gauge') gauges++;
      else if (def.type === 'histogram') histograms++;
    }
    return {
      definitions: this.definitions.size,
      counters,
      gauges,
      histograms,
    };
  }
}

// ─── Helpers ───

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}="${escapeLabel(labels[k] ?? '')}"`);
  return `{${parts.join(',')}}`;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Métricas padrão do ZEUS — pre-defined pra uso imediato.
 * Caller registra via `registerStandardMetrics(registry)` no boot.
 */
export const STANDARD_METRICS: MetricDefinition[] = [
  // Operations
  { name: 'zeus_operations_total', help: 'Total operations attempted', type: 'counter', labels: ['chain', 'protocol', 'outcome'] },
  { name: 'zeus_operations_confirmed_total', help: 'Operations confirmed on-chain', type: 'counter', labels: ['chain', 'protocol'] },
  { name: 'zeus_operations_reverted_total', help: 'Operations reverted on-chain', type: 'counter', labels: ['chain', 'protocol'] },
  { name: 'zeus_operations_pre_dispatch_rejected_total', help: 'Operations rejected by gates', type: 'counter', labels: ['chain', 'protocol', 'gate'] },

  // PnL
  { name: 'zeus_pnl_realized_usd_total', help: 'Realized PnL cumulative USD', type: 'gauge', labels: ['chain', 'protocol'] },
  { name: 'zeus_pnl_expected_usd_total', help: 'Expected PnL cumulative USD', type: 'gauge', labels: ['chain', 'protocol'] },
  { name: 'zeus_pnl_drift_bps', help: 'Avg PnL drift in bps (real - expected) / expected', type: 'gauge', labels: ['chain', 'protocol'] },

  // Gas
  { name: 'zeus_gas_usd_paid_total', help: 'Total gas USD paid', type: 'gauge', labels: ['chain'] },
  { name: 'zeus_gas_reserve_eth', help: 'Current gas reserve in ETH', type: 'gauge', labels: ['chain', 'account'] },

  // Health
  { name: 'zeus_uptime_seconds', help: 'Bot uptime in seconds', type: 'gauge', labels: ['service'] },
  { name: 'zeus_block_staleness_seconds', help: 'Seconds since last block observed', type: 'gauge', labels: ['chain'] },
  { name: 'zeus_process_memory_rss_mb', help: 'Process RSS memory MB', type: 'gauge', labels: ['service'] },
  { name: 'zeus_event_loop_lag_ms', help: 'Event loop lag in ms', type: 'gauge', labels: ['service'] },

  // Reorg
  { name: 'zeus_reorgs_total', help: 'Total reorgs detected', type: 'counter', labels: ['chain'] },
  { name: 'zeus_reorgs_in_window', help: 'Reorgs in current circuit-breaker window', type: 'gauge', labels: ['chain'] },

  // Auto-pause
  { name: 'zeus_auto_pause_active', help: 'Auto-pause active (1) or not (0)', type: 'gauge', labels: ['service'] },
  { name: 'zeus_auto_pause_reasons', help: 'Number of active pause reasons', type: 'gauge', labels: ['service'] },

  // Queue/dedup
  { name: 'zeus_dedup_pending', help: 'Positions in dedup pending state', type: 'gauge', labels: ['chain'] },
  { name: 'zeus_dedup_confirmed', help: 'Positions in dedup confirmed state', type: 'gauge', labels: ['chain'] },

  // Latency (histograms)
  { name: 'zeus_dispatch_duration_seconds', help: 'Dispatch duration from submit to confirm', type: 'histogram', labels: ['chain', 'protocol'] },
  { name: 'zeus_calculator_duration_seconds', help: 'Calculator execution duration', type: 'histogram', labels: ['chain', 'protocol'] },

  // Competitor scanner
  { name: 'zeus_competitor_profiles_total', help: 'Total competitor profiles tracked', type: 'gauge', labels: ['chain'] },
  { name: 'zeus_scanner_blocks_processed_total', help: 'Total blocks scanned by competitor scanner', type: 'counter', labels: ['chain'] },

  // Market-bribe (Fase 1) — quanto o mercado paga de priority fee pra ganhar inclusão
  { name: 'zeus_market_bribe_priority_fee_gwei', help: 'Market priority fee (gwei) pago por competidores, por percentil', type: 'gauge', labels: ['chain', 'percentile'] },
  { name: 'zeus_market_bribe_competitors_active', help: 'Competidores ativos no agregado de market-bribe', type: 'gauge', labels: ['chain'] },
];

/**
 * Helper: registra todas STANDARD_METRICS no registry.
 */
export function registerStandardMetrics(registry: MetricRegistry): void {
  for (const def of STANDARD_METRICS) {
    registry.define(def);
  }
}
