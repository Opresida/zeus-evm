/**
 * HTTP server minimalista pra health checks + controle remoto futuro.
 *
 * Endpoints (todos GET exceto onde indicado):
 *   GET  /health              → 200 OK se scraper vivo, body com state.json
 *   GET  /state               → retorna ScraperState completo
 *   POST /state/enable        → seta enabled=true
 *   POST /state/disable       → seta enabled=false
 *   POST /state/schedule      → body { schedule: 'every_12h' }
 *   POST /state/chains        → body { activeChains: ['base', 'optimism'] }
 *   GET  /report/latest       → retorna último ScraperReport JSON
 *
 * UptimeRobot pinga /health a cada 5min. Status 200 = healthy.
 * Quando bot crashar, UptimeRobot dispara alert Discord/email automaticamente.
 *
 * Implementação sem deps externas — usa só `node:http` nativo. Bind padrão
 * loopback 127.0.0.1 (só local). Pra expor externamente, frontend mobile usa
 * proxy via Fly.io / Tailscale.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { StateManager, ScheduleMode } from './state';

export interface HealthServerOpts {
  port: number;
  /** Host bind. Default 127.0.0.1 (loopback). Use '0.0.0.0' pra expor externamente. */
  host?: string;
  stateManager: StateManager;
  /** Pasta de reports pra servir GET /report/latest. */
  reportsDir: string;
  logger?: LoggerLike;
}

const VALID_SCHEDULES: ScheduleMode[] = ['manual', 'hourly', 'every_2h', 'every_6h', 'every_12h', 'daily'];

export function startHealthServer(opts: HealthServerOpts): Server {
  const { port, host = '127.0.0.1', stateManager, reportsDir, logger } = opts;

  const startedAt = Date.now();

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // Health check primário
      if (url === '/health' && method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'discovery-scraper',
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          state: stateManager.get(),
        });
      }

      // Retorna state completo (consumido pelo front-end mobile)
      if (url === '/state' && method === 'GET') {
        return sendJson(res, 200, stateManager.get());
      }

      // Toggle enable
      if (url === '/state/enable' && method === 'POST') {
        stateManager.setEnabled(true);
        return sendJson(res, 200, { enabled: true });
      }
      if (url === '/state/disable' && method === 'POST') {
        stateManager.setEnabled(false);
        return sendJson(res, 200, { enabled: false });
      }

      // Schedule update
      if (url === '/state/schedule' && method === 'POST') {
        const body = await readJson<{ schedule?: string }>(req);
        if (!body.schedule || !VALID_SCHEDULES.includes(body.schedule as ScheduleMode)) {
          return sendJson(res, 400, {
            error: 'invalid schedule',
            allowed: VALID_SCHEDULES,
          });
        }
        stateManager.setSchedule(body.schedule as ScheduleMode);
        return sendJson(res, 200, { schedule: body.schedule });
      }

      // Active chains update
      if (url === '/state/chains' && method === 'POST') {
        const body = await readJson<{ activeChains?: string[] }>(req);
        if (!Array.isArray(body.activeChains)) {
          return sendJson(res, 400, { error: 'activeChains must be string[]' });
        }
        stateManager.setActiveChains(body.activeChains);
        return sendJson(res, 200, { activeChains: body.activeChains });
      }

      // Último report
      if (url === '/report/latest' && method === 'GET') {
        const path = resolvePath(reportsDir, 'latest.json');
        if (!existsSync(path)) {
          return sendJson(res, 404, { error: 'no report yet — wait first scraper run' });
        }
        try {
          const raw = readFileSync(path, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(raw);
          return;
        } catch (err) {
          return sendJson(res, 500, { error: err instanceof Error ? err.message : 'read failed' });
        }
      }

      // 404 fallback
      sendJson(res, 404, { error: 'not found', path: url });
    } catch (err) {
      logger?.warn(
        { err: err instanceof Error ? err.message : err, url, method },
        'HTTP handler error',
      );
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  server.listen(port, host, () => {
    logger?.info(
      { host, port },
      `🌐 Health server escutando em http://${host}:${port}/health`,
    );
  });

  return server;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      if (!body) return resolve({} as T);
      try {
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
