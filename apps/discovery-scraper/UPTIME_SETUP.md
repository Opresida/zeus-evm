# Setup UptimeRobot pro Discovery Scraper

UptimeRobot é serviço de monitoring externo grátis (50 monitors no plano free).
Pinga `/health` endpoint a cada 5min — se cair, dispara alert Discord/email.

## 1. Habilitar health server no scraper

No `.env` da máquina onde scraper roda:

```bash
HEALTH_SERVER_ENABLED=true
HEALTH_SERVER_PORT=7878
HEALTH_SERVER_HOST=0.0.0.0   # expor externamente (atrás de Fly.io proxy)
```

Quando ativo, o processo do scraper fica vivo após o run (modo daemon) e o
servidor HTTP responde em `http://localhost:7878/health`.

## 2. Endpoints disponíveis

| Endpoint | Método | Função |
|---|---|---|
| `/health` | GET | Status check pra UptimeRobot (200 OK = healthy) |
| `/state` | GET | Retorna ScraperState atual (config + stats 24h) |
| `/state/enable` | POST | Ativa scraper (botão liga futuro) |
| `/state/disable` | POST | Desativa scraper |
| `/state/schedule` | POST | Body `{"schedule":"every_12h"}` |
| `/state/chains` | POST | Body `{"activeChains":["base","optimism"]}` |
| `/report/latest` | GET | Retorna último ScraperReport JSON |

## 3. Deploy em Fly.io

No `fly.toml` do scraper (a configurar quando subir):

```toml
[http_service]
  internal_port = 7878
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

Resultado: `https://<app>.fly.dev/health` exposto.

## 4. Configurar UptimeRobot

1. Cria conta free em https://uptimerobot.com
2. Add new monitor:
   - Type: **HTTP(s)**
   - URL: `https://<seu-app>.fly.dev/health`
   - Interval: **5 minutes** (free tier)
   - Friendly name: "ZEUS Discovery Scraper"

3. Add Alert Contact (Discord webhook ou email)

## 5. Endpoint health response exemplo

```json
{
  "status": "ok",
  "service": "discovery-scraper",
  "uptimeSec": 14523,
  "state": {
    "version": 1,
    "enabled": true,
    "schedule": "every_12h",
    "activeChains": ["base", "optimism", "arbitrum", "polygon_pos", "avax"],
    "lastRunAt": "2026-05-26T18:00:00.000Z",
    "nextRunAt": "2026-05-27T06:00:00.000Z",
    "stats24h": {
      "poolsAnalyzed": 1800,
      "candidatesQualified": 36,
      "newDiscoveries": 7,
      "topScore": 78.3,
      "topPair": "cbBTC/WBTC"
    }
  }
}
```

## 6. Equivalente pro backrun-engine + liquidator

Mesmo padrão — adicionar `HEALTH_SERVER_ENABLED=true` no `.env` desses apps
quando F5 receber o módulo httpServer também. Porta sugerida:

- discovery-scraper: 7878
- backrun-engine: 7879
- liquidator: 7880

Cada um vira monitor separado em UptimeRobot.
