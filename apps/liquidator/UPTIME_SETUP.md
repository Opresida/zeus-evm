# UptimeRobot Setup — Liquidator

Monitora `/healthz` endpoint do liquidator pra alertar quando bot cai.

## 1. Habilitar health server no .env

```bash
HEALTH_SERVER_ENABLED=true
HEALTH_SERVER_PORT=7880
HEALTH_SERVER_HOST=0.0.0.0   # expor externamente (atrás de Fly.io proxy)
```

`HEALTH_SERVER_HOST=127.0.0.1` mantém só local (dev).

## 2. Endpoints disponíveis

| Endpoint | Método | Função |
|---|---|---|
| `/healthz` | GET | Liveness simples (200 OK = bot vivo) |
| `/readyz`  | GET | Readiness detalhada (PnL, failure, gas, intelligence stats) |
| `/metrics` | GET | Prometheus-style (placeholder pra OB2 do item 16B) |

## 3. UptimeRobot (free tier — 50 monitors)

1. Cria conta free em https://uptimerobot.com
2. Add new monitor:
   - Type: **HTTP(S)**
   - URL: `https://<liquidator>.fly.dev/healthz`
   - Interval: **5 minutes** (free tier)
   - Friendly name: "ZEUS Liquidator (Base)"
3. Add Alert Contact (Discord webhook ou email)

## 4. Deploy Fly.io exemplo

```toml
[http_service]
  internal_port = 7880
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

## 5. Exemplo `/healthz` response

```json
{
  "status": "ok",
  "service": "liquidator",
  "version": "v8.2",
  "pid": 12345,
  "uptimeSec": 3600
}
```

## 6. Exemplo `/readyz` response (degraded)

```json
{
  "service": "liquidator",
  "uptimeSec": 3600,
  "status": "degraded",
  "checks": {
    "pnl": { "ok": true, "netPnlUsd24h": 12.34, "wins24h": 5, "losses24h": 1 },
    "failure": { "ok": true, "consecutiveFailures": 0 },
    "dedup": { "ok": true, "pending": 0, "confirmed": 3, "failed": 1 },
    "gas_reserve": { "ok": false, "reason": "warn", "balanceEth": "0.008", "balanceUsd": 24 },
    "intelligence_store": { "ok": true, "totalEvents": 1247, "pendingWrites": 3 },
    "event_ingester": { "ok": true, "eventsIngested": 1247, "eventsDropped": 0 }
  },
  "dispatchesPaused": false,
  "pausedReasons": []
}
```

## 7. Porta padrão por bot

- `7878`: discovery-scraper
- `7879`: backrun-engine
- `7880`: liquidator

Cada um vira monitor separado em UptimeRobot — alertas independentes.
