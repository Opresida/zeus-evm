# ZEUS EVM — Grafana Dashboards

Item 16B OB3+OB4 do checklist 16-items. Consome métricas Prometheus expostas pelo `MetricRegistry` em `/metrics` (porta 7880 liquidator, 7881 backrun).

## Dashboards

| Arquivo | Item | Foco |
|---|---|---|
| `zeus-operations.json` | OB3 | Ops rate, win rate, PnL, gas reserve, auto-pause, dedup, reorgs |
| `zeus-performance.json` | OB4 | Latency p50/p95/p99, calculator, scanner throughput, memória, event loop lag |

## Setup rápido

### 1. Prometheus (scrape config)

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'zeus-liquidator'
    scrape_interval: 15s
    static_configs:
      - targets: ['127.0.0.1:7880']
        labels: { service: 'liquidator' }

  - job_name: 'zeus-backrun'
    scrape_interval: 15s
    static_configs:
      - targets: ['127.0.0.1:7881']
        labels: { service: 'backrun' }
```

Se rodando em Fly.io, expor `HEALTH_SERVER_HOST=0.0.0.0` + abrir porta interna na fly.toml.

### 2. Grafana

1. Importar os dois JSONs via UI: **+ → Import → Upload JSON**.
2. Selecionar datasource Prometheus quando solicitado (variável `DS_PROMETHEUS`).
3. Salvar — vão aparecer em `Dashboards` com tags `zeus`, `evm`.

### 3. Validar métricas

```bash
curl -s http://localhost:7880/metrics | head -40
```

Deve retornar texto formato Prometheus com prefixo `zeus_*`. Lista completa em `STANDARD_METRICS` em [packages/execution-utils/src/observability/prometheusExporter.ts](../../packages/execution-utils/src/observability/prometheusExporter.ts).

## Painéis principais

### Operations Dashboard (OB3)

- **Top row (stats):** liquidator UP/DOWN, auto-pause, PnL 24h, gas reserve ETH
- **Operation rate** — txs/min por chain + protocol + outcome (confirmed/reverted/pre_rejected)
- **Win rate por protocolo** — rolling 1h (alerta: <50% amarelo, <30% vermelho conceitual)
- **PnL Expected vs Realized** — gap entre o que calculator previu vs realidade
- **PnL drift bps** — média ponderada por protocolo
- **Pre-Dispatch Gate Rejections** — qual gate (kill/cooldown/gas/dedup/quoter) mais rejeita
- **Block staleness** — quantos segundos desde último bloco visto (>10s = problema RPC)
- **Dedup pending/confirmed**
- **Reorgs in window** — detecção de instabilidade L2

### Performance Dashboard (OB4)

- **Top row (stats):** dispatch p50/p95, event loop lag, memória RSS
- **Dispatch latency distribution** — p50/p95/p99 por chain
- **Calculator latency** — quanto demora pra calcular oportunidade
- **Competitor profiles tracked** — crescimento do registry
- **Block scanner throughput** — blocos/min do background scanner
- **Memory + uptime trends**

## Thresholds opinionados

| Métrica | Verde | Amarelo | Vermelho |
|---|---|---|---|
| Gas reserve ETH | >0.1 | >0.05 | <0.05 |
| Dispatch p50 | <1s | <3s | >3s |
| Dispatch p95 | <2s | <5s | >5s |
| Event loop lag | <30ms | <100ms | >100ms |
| Process RSS | <512MB | <1GB | >1GB |
| Win rate (1h) | >70% | >50% | <50% |

Ajustar conforme baseline real após 1 semana de produção.

## Refresh + retenção

- Dashboards auto-refresh 30s
- Time range default: 6h (operations), 3h (performance)
- Prometheus retention recomendada: 30d (queries de drift comparam offset 24h)

## Próximos painéis (futuro)

- **Cost breakdown** (Item 10 P4): base/priority/L1/bribe stacked area
- **Competitor classification distribution** (Item 5 F7): pie chart por categoria
- **Cooccurrence cluster size** (Item 5 F8): top N clusters detectados
- **Failure attribution** (Item 4 A8): donut por FailureCategory

Quando exportar essas métricas adicionais no MetricRegistry, expandir os JSONs.
