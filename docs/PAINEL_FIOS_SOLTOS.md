# 🔌 Painel — Fios Soltos & Prontidão (auditoria 2026-07-01)

Registro do pente-fino de **fios soltos** (dado que o bot já coleta mas não chega ao painel) e da **prontidão
completa das abas Saúde e Inteligência**. Tudo **100% off-chain**, com **mock sempre espelhando o AO VIVO**
(regra: `feedback_mock_mirrors_live`). 3 agentes de auditoria: fios soltos frontend, cards da Saúde, automações.

## Ponte de dados (relembrete)
`bot heartbeat/eventos` → `genericWebhookSink` → `frontend/app/api/ingest/route.ts` (sanitizers na fronteira) →
Supabase (`events` / `service_status`) → `lib/live.ts` (`deriveSnapshot`) → `lib/types.ts` → `lib/viewModel.ts` →
`components/screens/*.tsx`. Modo **DEMO** (`live==null`) usa `lib/mockData.ts`; **AO VIVO** usa `EMPTY` como fallback
(card sem dado → "—", nunca mock).

## ✅ Aba Saúde — Prontidão dos componentes (4 → até 9, rotulados por motor)
| Componente | Fonte | Verde quando |
|---|---|---|
| `M1/M2 · rpc / Base` | `BlockStalenessCheck` (frescor de bloco, 0 RPC extra) | RPC responde; vermelho "sem resposta" |
| `M1/M2 · auto-pause` | `autoPauseManager` | não pausado |
| `M1 · gás-reserva` / `M2 · gás-reserva` | `GasReserveTracker` (M2 = novo, read-only via `botAccount`/`watchAccount`) | saldo acima do piso |
| `M1/M2 · reorg` | `finalityTracker.stats().reorgsInWindow` | 0 reorgs na janela |
| `M1 · kill-switch` / `M2 · perda 24h` | `pnlTracker` (M2 não auto-mata → nome honesto "perda 24h") | perda < limite |
| `M1/M2 · porteiro-tokens` | freshness do re-vet (`vettingRevetAt`) | re-vet fresco |

`live.ts` **funde os componentes de TODOS os motores** (antes mostrava só um → M2 invisível), ordem estável M1→M2.

## ✅ Aba Saúde — outros fios
- **Taxa de erro real** — `errorMetrics {failedOps,totalOps}` do `FailureTracker` no heartbeat. 0 ops (DRY_RUN) → "—" honesto.
- **Uptime real** no AO VIVO — o heartbeat já trazia `uptimeSec`; o painel passou a usar (antes "—" fixo).
- **Radar de descoberta multi-motor** — o M2 passa a emitir pulso próprio (pares varridos/viáveis/inviáveis);
  `live.ts` mostra o serviço **mais fresco** com discovery, rotulado por motor.

## ✅ Parte 2 do relatório de fios soltos — 6 itens acionáveis (100% feitos)
| # | Item | O que ficou |
|---|---|---|
| 1&2 | `partial` / `decimals` | selo "⚠ dados parciais" na tela Tokens; **`decimals` eliminado** (o bot nunca lê o universo de volta → peso morto) |
| 3 | Motor 2 invisível no DRY_RUN | **arb cross-DEX vira estratégia** (`StrategyKey 'arb'`) → tela Estratégias mostra o POTENCIAL do arb |
| 4 | Diagnóstico de concorrência no log | builders dominantes + posição no bloco → card novo na **Inteligência** (`HeartbeatCompetition` + `BlockPositionTracker.summary()`) |
| 5 | "Perdemos pra quem?" anônimo | `failure.recorded` emite `competitorSender`+`winnerPriorityFeeGwei`; painel: alias → endereço curto → "desconhecido" |
| 6 | Saldo em US$ furado no DRY_RUN | novo `ctx.watchAccount` (só-leitura, deriva da chave, nunca assina) → check de gás popula saldo+US$+runway |

## 🟡 Parte 2 — cosméticos restantes (baixo valor, deixados pro final)
| # | Cosmético | Nota |
|---|---|---|
| 7 | Alertas de drift (auto-correção) só no log | não chegam ao painel |
| 8 | Contador "concorrente nos venceu X vezes" | `wonVsUs` já chega e está tipado — sobra ajuste fino de type-safety |
| 9 | Ranking de pares com edge sem histórico | só mostra o "agora" |
| 10 | Motivo do lance de gorjeta às vezes vazio | mostra o valor, não o "porquê" |
| 11 | `ActivityPatternTracker` (horário dos competidores) | feature futura (Atena) |
| ~~12~~ | ~~Motor 2 não reporta gás sozinho~~ | ✅ **FEITO** (GasReserveTracker no M2, Saúde) |

## Correções de rota honestas (o agente superestimou)
- O **filler UniswapX** já estava corretamente ligado (alimenta o `strategyTracker` no DRY_RUN).
- A **conversão USD** do saldo já existia (o `GasReserveTracker` calcula pelo `ETH_USD_PRICE_ESTIMATE`); o gap real era o `account` ausente em DRY_RUN.
- `decimals` no painel era peso morto. Sempre verificado no código antes de implementar.

## Adiado (documentado, NÃO esquecido)
- **Gráfico de latência 24h** — precisa histórico no Supabase + só faz sentido com execução real frequente.
- **Event log vazio após 30s sem evento** — cosmético.

## Próximo: Parte 3 do relatório — **Automações** (14 oportunidades)
Relatório de um agente (2026-07-01): auto-calibrar parâmetros hoje fixos com base no que o ledger/trackers já
coletam, sempre com trava + aviso + reversível. Destaque de melhor valor/esforço: **ligar o "lucro mínimo
auto-calibrável"** (`adaptiveThresholds` já existe, opt-in `ADAPTIVE_THRESHOLDS_ENABLED=false`). A ver com o Humberto.

> **Sem contrato tocado.** Tudo é observabilidade/gate de software. `forge test` permanece **191** (intocado).
