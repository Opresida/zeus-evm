/**
 * Observability module — Item 16B OB1+OB5 do checklist 16-items.
 *
 * Esta release entrega:
 *  - Tracer lightweight (trace_id + span_id + AsyncLocalStorage)
 *  - StructuredLogger wrap em pino com auto-injection
 *
 * Compatível com swap futuro pra OpenTelemetry real (`@opentelemetry/sdk-node` +
 * Jaeger exporter). Interface Span similar à OTel API.
 *
 * Próximos componentes (OB2-OB12):
 *  - Prometheus exporter (/metrics endpoint)
 *  - Grafana dashboards JSON (Overview/Liquidator/Backrun/PnL/Competitor/Health)
 *  - operationReplayer (reconstrói op específica)
 *  - decisionAuditTrail (registro de cada decisão crítica)
 *  - costTracker (RPC + gas + infra + net margin por chain)
 *  - alertManager (consolida + escala severidade)
 */

export {
  Tracer,
  Span,
  type TracerOpts,
  type SpanData,
  type SpanStatus,
} from './tracer';

export {
  createStructuredLogger,
  type StructuredLoggerOpts,
} from './structuredLogger';
