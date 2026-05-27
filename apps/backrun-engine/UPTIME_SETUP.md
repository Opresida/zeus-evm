# UptimeRobot Setup — Backrun Engine

Monitora `/healthz` endpoint do backrun-engine pra alertar quando bot cai.

## 1. Habilitar health server no .env

```bash
HEALTH_SERVER_ENABLED=true
HEALTH_SERVER_PORT=7879
HEALTH_SERVER_HOST=0.0.0.0   # expor externamente (atrás de Fly.io proxy)
```

`HEALTH_SERVER_HOST=127.0.0.1` mantém só local (dev).

## 2. Endpoints disponíveis

| Endpoint | Método | Função |
|---|---|---|
| `/healthz` | GET | Liveness simples (200 OK = bot vivo) |
| `/readyz`  | GET | Readiness detalhada (PnL, failure, intelligence stats) |
| `/metrics` | GET | Prometheus-style (placeholder pra OB2 do item 16B) |

## 3. UptimeRobot (free tier)

1. Add new monitor:
   - Type: **HTTP(S)**
   - URL: `https://<backrun>.fly.dev/healthz`
   - Interval: **5 minutes**
   - Friendly name: "ZEUS Backrun-Engine (Base)"
2. Discord webhook como alert contact.

## 4. Exemplo `/readyz` response

```json
{
  "service": "backrun-engine",
  "uptimeSec": 3600,
  "status": "ok",
  "checks": {
    "pnl": { "ok": true, "netPnlUsd24h": 0, "wins24h": 0, "losses24h": 0 },
    "failure": { "ok": true, "consecutiveFailures": 0 },
    "intelligence_store": { "ok": true, "totalEvents": 0, "pendingWrites": 0 },
    "event_ingester": { "ok": true, "eventsIngested": 0, "eventsDropped": 0 }
  },
  "dispatchesPaused": true,
  "pausedReasons": ["dryrun (no dispatches submitted)"]
}
```

## 5. Porta padrão por bot

- `7878`: discovery-scraper
- `7879`: backrun-engine
- `7880`: liquidator
