# Cobertura de Dados do Painel — Mock → Real (plano robusto)

> **Pergunta do Humberto:** todo card do painel está pronto pra transmitir dado REAL? Se não, plano
> pra cobrir tudo no Supabase — o front foi desenhado alinhado com o backend do ZEUS.
>
> **Resposta:** ainda não 100%, **mas o bot já COMPUTA quase tudo** (camada OIE: PnL/competidores/
> market-bribe/drift/latência/health/calibração/ranking). O gap é **transmissão (heartbeat/events) +
> fiação no front** — não é refazer o backend. Ferramenta de acompanhamento: o **toggle DEMO/LIVE**
> (em LIVE, card vazio = ainda não fiado).

## Carriers (como o dado chega no painel)
1. **`events`** (append + Realtime INSERT) — eventos discretos: `tx.confirmed/reverted`, `failure.recorded`, `whale.swap_detected`, `backrun.*`, e os novos `race.lost`/`calibration.applied`. `payload jsonb` absorve qualquer tipo.
2. **`service_status`** (UPSERT 1 linha/serviço + Realtime UPDATE) — **snapshots/gauges**: gás, uptime, estado real (autoPaused), `discovery`, `intel`, e os novos blocos `health`/`competitors`/`edge_pairs`/`cooldowns`/`kill_switch`.
3. **Views SQL** (`pnl_daily`/`pnl_weekly`/`pnl_by_protocol`) — agregados derivados de `events`.

**Princípio:** estado-pulso (gauge) → `service_status`; evento discreto → `events`; agregado histórico → view/tabela. Heartbeat **nunca** vai pra `events` (inundaria) — sempre `service_status`.

## Mapa por card (fonte real + status)

| Tela / Card | Fonte real (o bot já tem) | Carrier | Status |
|---|---|---|---|
| **Home** Net PnL hoje | events (sum net 24h) | events | 🟡 hoje fiado; falta winRate/ok/fail consistentes |
| Net PnL 7d / 30d / projeção / w14sum | `pnl_weekly`/`pnl_daily` | view | 🔴 Tier 1 (front) |
| Win rate (hoje) | events ok/fail | events | 🟡 parcial |
| Gráfico 14d (barras) | `pnl_daily` (últimos 14) | view | 🔴 Tier 1 |
| Gás na carteira + runway | heartbeat `gasReserveEth/Usd` | service_status | 🟢 fiado |
| Status do bot / kill switch / cooldown / min EV | heartbeat (autoPaused, adaptiveMinEv) + `kill_switch` novo | service_status | 🟡 parcial (falta kill_switch loss/limit) |
| Mini-cards por motor (M1/M2/M3) | events por motor + heartbeat motorStats | events/ss | 🟢 fiado |
| Insights & anomalias | regras sobre drift/concentração/bribe/runway | events `insight` (novo) ou derivado no front | 🔴 Tier 3 |
| Eventos ao vivo (ticker) | events recentes | events | 🟢 fiado |
| **Transações** (tabela/cards) | events `tx.*` | events | 🟢 fiado |
| **PnL** realizado vs esperado (chart) | `pnl_daily` + `pnl.reconciled` (expected) | events/view | 🔴 Tier 1 |
| PnL drift / gás | `pnl.reconciled` (avg_drift) + events gas | events | 🔴 Tier 1 |
| Lucro por motor / por protocolo | `pnl_by_protocol` + motor map | view | 🔴 Tier 1 |
| **Carteira** gás 24h/30d | events (sum gas por janela) | events | 🔴 Tier 1 |
| Histórico de saldo 30d (chart) | snapshot diário de saldo | `wallet_snapshots` (tabela nova) | 🔴 Tier 2 |
| Alertas de gás baixo | events `gas.alert/recovered` | events | 🟡 (emitir/derivar) |
| **Inteligência** market-bribe P50/P75/P95 | `senderRegistry.marketBribeStats()` | heartbeat `intel` (+p75) | 🟡 p50/p95 fiados; falta p75 |
| Drift sustentado (alarmes) | `pnl.reconciled` / driftTracker | events/ss | 🟢 fiado |
| Competidores (lista won/lost/bribe/kind) | `senderRegistry`/`blockHistoryScanner` | heartbeat `competitors` (novo) | 🔴 Tier 2 |
| Post-mortem (corridas perdidas) | `competitorResolver`/`blockPositionTracker` | events `race.lost` (novo) | 🔴 Tier 2 |
| Auto-calibração (log) | `calibrationDriftTracker`/adaptive | events `calibration.applied` (novo) | 🔴 Tier 2 |
| Ranking de pares com edge | mis-scanner MIS ranking (DuckDB) | heartbeat `edge_pairs` (novo, Motor 2) | 🔴 Tier 2 |
| **Saúde** prontidão componentes (/readyz) | health/blockStaleness/processCheck | heartbeat `health` (novo) | 🔴 Tier 2 |
| Latência dispatch p50/p95 (chart) | Prometheus `zeus_dispatch_*` | heartbeat `latency` (atual) + acúmulo no front | 🔴 Tier 2 |
| Kill switch · perda 24h / limite | pnlTracker 24h + limite | heartbeat `kill_switch` (novo) | 🔴 Tier 2 |
| Cooldowns & auto-pause | autoPauseManager/failureTracker | heartbeat `cooldowns` (novo) | 🔴 Tier 2 |
| Registro de eventos do sistema | events (todos os tipos) | events | 🟢 fiado |
| **Relatórios** net/win/ops/gás/drift | `pnl_*` views + events | view/events | 🔴 Tier 1 |

## Plano de execução (3 fases)

### Fase 1 — Tier 1 (SÓ frontend; o bot já emite os eventos)
Fiar `live.ts`/`viewModel.ts` pra derivar dos `events` + views já existentes:
- KPIs 7d/30d/projeção, win-rate, gráfico 14d, PnL realizado vs esperado, lucro por motor/protocolo, carteira gás 24h/30d, relatórios.
- **Zero mudança no bot.** Precisa do bot rodando p/ acumular histórico.
- Inclui criar as queries das views no `lib/live.ts` (hoje ele só lê `events` cru + `service_status`).

### Fase 2 — Tier 2 (bot transmite + Supabase carrega)
**Supabase (migração):** adicionar a `service_status` os blocos jsonb: `health`, `competitors`, `edge_pairs`, `cooldowns`, `kill_switch`, `latency`. + tabela `wallet_snapshots` (service, balance_eth, balance_usd, ts) p/ o chart de saldo 30d. (Novos tipos de evento `race.lost`/`calibration.applied`/`insight` NÃO precisam de schema — `events.payload jsonb` absorve.)

**Bot (heartbeat enriquecido — reusa o loop de métricas, sem cálculo novo):**
- liquidator: anexar `health` (readyz), `competitors` (lista), `cooldowns`, `kill_switch` (loss24h/limit), market-bribe p75, `latency` (p50/p95 atual) ao heartbeat.
- mis-scanner: anexar `edge_pairs` (ranking de persistência) ao heartbeat.
- emitir `race.lost` (post-mortem) e `calibration.applied` (calib) como **events**.
- snapshot diário de gás → `wallet_snapshots`.
- `/api/ingest`: rotear os blocos novos do heartbeat → colunas/jsonb de `service_status`.

**Frontend:** consumir os blocos novos em `live.ts` + fiar os cards correspondentes no `viewModel`.

### Fase 3 — Tier 3 (gerado)
- `insights` (anomalias): regra simples sobre drift/concentração/bribe/runway — emitir como event `insight` ou computar no painel a partir dos dados das Fases 1/2.

## Resultado esperado
Ao fim, no modo **LIVE** o painel mostra **só dado real** (e o que estiver sem dado fica vazio, não mock). O toggle DEMO segue pra apresentação/marketing.

## Ordem recomendada
Fase 1 primeiro (rápida, sem mexer no bot, já enche metade do painel assim que o bot rodar) → Fase 2 (a maior, transmissão) → Fase 3 (polish). Cada card vira um checkbox; o toggle LIVE valida.

---

## ✅ Status de execução

### Fase 1 — FEITA (commit `e1ba7dd`)
KPIs 7d/30d/projeção/w14sum, barras 14d, série PnL realizado vs esperado, breakdown por motor/protocolo, gás 24h/30d, relatórios por período — tudo derivado de `events` no `live.ts`, fiado no `viewModel`. Testes: frontend 6/6 + typecheck 0.

### Fase 2 — FEITA (esta sessão)
**Supabase:** colunas jsonb `health`/`competitors`/`edge_pairs`/`cooldowns`/`kill_switch` adicionadas a `service_status`.
**Bot (heartbeat enriquecido, reusa o loop de métricas):**
- liquidator: `health` (4 componentes), `competitors` (`topThreats(8)`), `cooldowns` (`pauseStatus.reasons`), `kill_switch` (`currentLoss24h` vs `DAILY_LOSS_LIMIT_USD`), **market-bribe p75** no `intel`.
- mis-scanner: `edge_pairs` (`mis.ranking()`).
- `/api/ingest` roteia os blocos novos → colunas de `service_status`.
**Frontend:** `live.ts` consome os blocos; `viewModel` fia os cards (bribe P50/P75/P95, competidores, edge pairs, componentes de saúde, cooldowns, kill switch). Testes: frontend 7/7 + typecheck 0 · bot heartbeat 6/6 + typecheck 13/13.

**Fase 2b (deferido — precisa de pontos de emissão novos no bot, não só reuso):**
- `race.lost` (post-mortem de corridas perdidas) + `calibration.applied` (log de auto-calibração) como **events**.
- `competitors`: won/lost real por-corrida (hoje "won" mostra txs observadas; bribe/kind/nome já são reais).
- Latência dispatch p50/p95 (extrair dos histogramas Prometheus) + acúmulo do chart no front.
- `wallet_snapshots` (tabela) + writer diário de saldo → chart de saldo 30d.

### Fase 3 — pendente
`insights` (anomalias): regra sobre drift/concentração/bribe/runway, computada no painel a partir dos dados das Fases 1/2.
