/**
 * Health Server — Item 12 H8+H11 do checklist 16-items.
 *
 * HTTP server minimalista pra liveness + readiness probes externos.
 * Reusável por liquidator + backrun-engine + futuras engines.
 *
 * **Por que importa:** bot morre em silêncio sem isso.
 * Cenários reais flagados no audit:
 *   - RPC lento → liquidations expiram → ninguém sabe
 *   - Subgraph 10min sem indexar → bot acha que não tem oportunidades
 *   - Sequencer Base trava → bot acumula pendings
 *   - Process trava em loop → nenhum heartbeat
 *
 * Endpoints (todos GET):
 *   /healthz  → liveness simples (200 = bot vivo)
 *   /readyz   → readiness detalhada (checks por componente)
 *   /metrics  → placeholder Prometheus (futuro item 16B)
 *
 * UptimeRobot pinga /healthz a cada 5min. Falha 2x consecutivas = alerta Discord.
 *
 * Implementação sem deps externas — só `node:http` nativo.
 * Bind padrão `127.0.0.1` (loopback). Pra expor externamente (Fly.io proxy etc),
 * usar `host: '0.0.0.0'`.
 */

import { createServer, type Server } from 'node:http';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

/**
 * Provider de readiness data. Cada bot implementa pra expor seu state interno.
 * Pode retornar `Promise` se precisa async (consultar trackers, etc).
 */
export type ReadinessProvider = () => Promise<ReadinessReport> | ReadinessReport;

/**
 * Snapshot do estado do bot pra readiness probe.
 * Estrutura flexível — cada componente reporta seu próprio status.
 */
export interface ReadinessReport {
  /** Aggregate: 'ok' (tudo verde) | 'degraded' (algum warn) | 'critical' (algo crítico falhando). */
  status: 'ok' | 'degraded' | 'critical';
  /** Checks individuais por componente. */
  checks: Record<string, ComponentCheck>;
  /** Flag global indicando se dispatches estão pausados. */
  dispatchesPaused: boolean;
  /** Razões da pausa (vazio se rodando). */
  pausedReasons?: string[];
}

export interface ComponentCheck {
  /** Componente está saudável? */
  ok: boolean;
  /** Texto explicativo (opcional). */
  reason?: string;
  /** Métricas associadas (opcional). */
  [metricKey: string]: unknown;
}

export interface HealthServerOpts {
  /** Nome do serviço pra responses ('liquidator', 'backrun-engine', etc). */
  serviceName: string;
  /** Porta de bind. */
  port: number;
  /** Host bind. Default '127.0.0.1' (loopback). Use '0.0.0.0' pra expor. */
  host?: string;
  /** Versão do bot (pro endpoint /healthz). */
  version?: string;
  /** Provider que retorna readiness snapshot. */
  readinessProvider: ReadinessProvider;
  logger?: LoggerLike;
}

/**
 * Inicia HTTP server. Retorna handle pra graceful shutdown.
 */
export function startHealthServer(opts: HealthServerOpts): Server {
  const {
    serviceName,
    port,
    host = '127.0.0.1',
    version = 'unknown',
    readinessProvider,
    logger,
  } = opts;

  const startedAt = Date.now();

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // Liveness — resposta simples e rápida
      if (url === '/healthz' && method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          service: serviceName,
          version,
          pid: process.pid,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        });
      }

      // Readiness — detalhada, consulta state interno
      if (url === '/readyz' && method === 'GET') {
        const report = await readinessProvider();
        // Convenção: HTTP status reflete severidade
        //  'ok'       → 200
        //  'degraded' → 200 (ainda funcional)
        //  'critical' → 503 (load balancer remove deste host)
        const httpStatus =
          report.status === 'critical' ? 503 :
          report.status === 'degraded' ? 200 :
          200;
        return sendJson(res, httpStatus, {
          service: serviceName,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          ...report,
        });
      }

      // Metrics — placeholder Prometheus pra Item 16B OB2
      if (url === '/metrics' && method === 'GET') {
        return sendText(res, 200,
          `# TYP zeus_uptime_seconds gauge\nzeus_uptime_seconds{service="${serviceName}"} ${Math.floor((Date.now() - startedAt) / 1000)}\n`,
        );
      }

      // 404
      return sendJson(res, 404, { error: 'not found', path: url });
    } catch (err) {
      logger?.warn(
        { err: err instanceof Error ? err.message : err, url, method },
        'HealthServer: erro processando request',
      );
      return sendJson(res, 500, { error: 'internal error' });
    }
  });

  server.listen(port, host, () => {
    logger?.info(
      { service: serviceName, host, port, version },
      `🩺 Health server pronto — http://${host}:${port}/healthz`,
    );
  });

  // Don't block process exit
  server.unref();

  return server;
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
}

function sendText(res: import('node:http').ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}
