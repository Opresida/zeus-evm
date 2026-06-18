/**
 * Intelligence module — Item 15 do checklist 16 items.
 *
 * Hub central de coleta + persistência de dados históricos pra:
 *  - Insights operacionais (qual horário mais rentável, qual pool melhor, etc)
 *  - Dataset principal pra IA futura (Item 16A)
 *  - Anomaly detection + correlation analysis
 *
 * Componentes ativos nesta release (Fase 0 / I1+I2):
 *  - `TimeseriesStore` — DuckDB embedded com batched writes
 *  - `EventIngester` — subscriber do EventBus, normaliza ZeusEvent → HistoricalEvent
 *  - `intelligenceSchema` — schema canonical + DDL + utilities
 *
 * Próximos componentes (I3-I13):
 *  - Aggregators (hourly, weekday, pool profitability, cascade)
 *  - Classifiers (market regime, whale activity, seasonality)
 *  - Anomaly detector + correlation analyzer
 *  - Query engine + feature store + weekly insight report
 */

export {
  TimeseriesStore,
  type TimeseriesStoreOpts,
  type TimeseriesStats,
} from './timeseriesStore';

export {
  EventIngester,
  type EventIngesterOpts,
  type IngesterStats,
} from './eventIngester';

export {
  type HistoricalEvent,
  type EventCategory,
  type EventMode,
  type EventSeverity,
  EVENTS_TABLE_DDL,
  computeTimeDimensions,
  generateEventId,
} from './intelligenceSchema';

export {
  resolveIntelligenceDbPath,
  buildObservationEvent,
  ingestSnapshot,
  queryTopOpportunityPairs,
  attachAndRankPairs,
  type ObservationInput,
  type TopPairRow,
  type TopPairsOpts,
} from './observation';
