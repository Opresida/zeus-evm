# TODO — ZEUS EVM

> ## 🔧 REMEDIAÇÃO DE FIOS SOLTOS (auditoria 2026-06-18) — ver [docs/LOOSE_WIRES.md](./docs/LOOSE_WIRES.md)
>
> **Realidade honesta:** dos 3 motores, só o **Motor 1 (liquidator)** fatura hoje — e estrangulado.
> Motor 2 = **motor de execução cross-DEX com execução DESLIGADA por default** (`ARB_EXECUTION_ENABLED=false`
> / `ARB_MODE=dryrun` → observa em `mis_observed` até ligar). Motor 3 = **morto em prod** (feed de mempool é placeholder).
>
> **Remediado (merge 2026-06-22, com testes):**
> - [x] **H2 — fallback de RPC no liquidator.** Alchemy como fallback do dRPC via `fallback([...])`
>   (espelha o backrun); `BASE_RPC_FALLBACK` agora é lido.
> - [x] **H3 — discovery Aave/Seamless resiliente.** Roda on-chain SEMPRE; TheGraph só como acelerador
>   (Seamless on-chain não é mais pulado quando `THEGRAPH_API_KEY` ausente).
> - [x] **Seletor flashloan 0% no arb (Motor 2)** — ligado (liquidator já estava ok). _Backrun ainda
>   força Aave 0,05% (pendente, sem impacto hoje — Motor 3 bloqueado)._
> - [x] **Qualidade de dado/config:** guard `fetchEthUsd<=0` (gás nunca $0), schema zod no mis-scanner,
>   priority fee real na reconciliação, `MOONWELL_LIQUIDATOR_ADDRESS` → `optionalAddress`, `Math.round` bps (INT32).
> - [x] **classes órfãs de ALTA ligadas:** `PnlAggregator`, `CalibrationDriftTracker`,
>   `CompetitorResolver`/`BlockPositionTracker` (leverage de calibração; não bloqueia trade).
> - [x] **Motor 2 execução** — **FEITO**: virou motor de execução cross-DEX (`arbDispatcher`/`arbOpportunity`
>   + config zod), **OFF por default** (`ARB_EXECUTION_ENABLED=false`). Travas: circuit breakers
>   (MAX_TRADE_ETH/MIN_ARB_PROFIT_USD/slippage) zod; `EXECUTOR_PRIVATE_KEY` exclusiva; simula+EV gate antes
>   de disparar; re-cota fresco; flashloan-only/atômico. Pendente: **execução triangular** (`findTriangularCycles`
>   já detecta read-only) + calibrar/ligar em mainnet (depende de DRY_RUN + decisão).
>
> **Deferido (decisão/recurso):**
> - [ ] **Motor 3 mempool** — Alchemy Growth+ / Flashblocks WS (aguardando infra). Sem isso, Motor 3 não dispara.
> - [ ] **Fly.io `deploy/fly/backrun-engine.toml` + volume persistente** — aguardando recurso (Humberto avisa ao subir).
> - [ ] **Seletor flashloan 0% no backrun** (`txBuilder.ts` força Aave 0,05%; sem impacto hoje — Motor 3 bloqueado).
> - [ ] **`approvedDexAdapters`** — regra do CLAUDE.md sem enforcement on-chain: decidir whitelist vs ajustar doc.
> - [ ] **`OrphanRecoveryManager`** — re-submissão de tx órfã pós-reorg; só faz sentido no modo LIVE.

> ## 📍 ESTADO ATUAL (2026-06-15)
>
> **Pronto (código):** 4 contratos v8 SPLIT — EIP-170 (BribeManager + ZeusLiquidator + ZeusArbExecutor + ZeusMoonwellLiquidator;
> não é mais o `ZeusExecutor` monolítico v6) · Motor 1 com 5 protocolos (Aave/Compound/Morpho/Seamless/Moonwell) ·
> multi-chain code-ready (Base/Arb/OP/Polygon/Avalanche) · Motor 2 = motor de execução cross-DEX MIS (multicall + derivação
> on-chain + flash sizing + gate de profundidade + Trader Joe LB + detecção triangular; **execução OFF por default**) ·
> Motor 3 backrun engine · **flashloan multi-fonte 0%** (Morpho + Balancer primário,
> Aave 0.05% fallback) · **Sprint 3 completo** (Compound III + Morpho Blue + Moonwell pipelines TS) ·
> **camada OIE FEITA** (Etapa A scoring + ledger DuckDB; Etapa B EV gate competitor-aware no backrun + EV gate ciente de OEV
> no liquidator priorizando Morpho; DRY_RUN detector+MIS gravando no ledger; Fly.io deploy configs com volume persistente) ·
> **115 funções de teste Foundry (9 arquivos; unit 78/79 + fork verde) + ~404 testes TS (execution-utils 336/336)** · typecheck 13/13 · 0 falhas (inclui prova de lucro dos 3 motores via Alchemy).
>
> **7 apps:** detector · backtest · monitor · liquidator (Motor 1) · backrun-engine (Motor 3) · discovery-scraper · mis-scanner (Motor 2 — motor de execução cross-DEX, execução OFF default).
> **6 packages:** chain-config · dex-adapters · strategy · aave-discovery · execution-utils (utils compartilhados + OIE) · shared-types.
>
> **Falta pra produção:** deploy mainnet dos 4 contratos (hoje só Sepolia) · capital + multisig · 2 semanas DRY_RUN observação
> mainnet read-only (detector + MIS gravando no ledger) · decisão sobre arb-engine · RPC pago + Fly.io (24/7) ·
> Motor 3 ao vivo precisa mempool premium · audit externo (capital > $50k).
>
> **Lucro real até hoje: US$ 0** — lógica provada em fork, contratos ainda em Sepolia (NÃO mainnet). (Detalhes no relatório PDF, §5.5/5.6.)
>

---

## 🆕 SESSÃO 2026-06-23 — DEX Motor 2 + toggle + cola do painel

**✅ Concluído (na `main`, commits `fcfc7be`→`f57222d`; detalhes em `CLAUDE.md`):**
- Expansão de DEX do Motor 2 (Slipstream + forks UniV3/UniV2) + **adapter `PancakeV3Lib`/`DexType.PancakeV3`** (Sushi V3 na Base também usa deadline — verificado on-chain).
- DexType unificado (fonte única `shared-types` + pin test).
- **Endereços de venue verificados on-chain** (Alchemy archive) — dackieswap-v2 e rocketswap removidos.
- **RPC = Alchemy primário** (dRPC free descartado) + `BASE_RPC_ARCHIVE` + `pnpm contracts:test:fork`.
- **CI:** fix `forge install` (sem `--no-commit`) + pin libs + job `contracts-fork` (trap de endereços).
- **Redeploy Base Sepolia v8** (com adapters): novos endereços + `revive()` + `setOperator(0xE060…)` nos 2 executors.
- **Cola do painel:** Supabase criado/verificado; `genericWebhookSink` com `x-zeus-secret`; mis-scanner liga sink + emite `zeus.heartbeat`.

**🔜 Falta (próxima sessão):**
- [ ] **Vercel:** setar 4 envs (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ZEUS_WEBHOOK_SECRET) + redeploy → painel sai do demo.
- [ ] **Bot `.env`:** preencher `GENERIC_WEBHOOK_URL` = `<URL do painel Vercel>/api/ingest`.
- [ ] **GitHub:** setar secret `BASE_RPC_ARCHIVE` (ativa o trap `contracts-fork` do CI).
- [ ] **Moonwell testnet:** `revive()` + `setOperator()` (se usar Motor 1 Moonwell — ficou kill switch ativo).
- [ ] **Subir a VM na Fly.io** + secrets; depois **2 semanas DRY_RUN**.
- [ ] **Mainnet (futuro):** owner=multisig + operador separado (no testnet ficou owner==operador).
>
> **Achado OEV (CRÍTICO pra estratégia):** liquidação na Base está se fechando por OEV capture (Aave SVR ~85%, Compound ~85%,
> Moonwell MEV tax ~99%). **Morpho Blue = único edge real (recapture 0%)** — o liquidator agora prioriza Morpho via gate EV pós-OEV.
> Detalhes em [`docs/refs/competitive-landscape.md`](./docs/refs/competitive-landscape.md) e [`docs/OIE_PROGRESS.md`](./docs/OIE_PROGRESS.md).
>
> **Marco 2026-06-22 — merge dos 3 blocos no `main`:** (1) inteligência OIE completa (incl. Etapa C thresholds adaptativos
> opt-in + Etapa D parcial: exporter + 3 dashboards Grafana); (2) fios soltos remediados (RPC fallback, discovery on-chain
> sempre, flashloan 0% no arb, qualidade de dado/config, classes órfãs ligadas); (3) **Motor 2 virou motor de execução
> cross-DEX** (`arbDispatcher`/`arbOpportunity` + config zod) com **execução OFF por default** + detecção triangular
> (read-only). Status INALTERADO: Sepolia (NÃO mainnet) · lucro real US$ 0 · edge = Morpho · execução opt-in / DRY_RUN-first.
> Pendente: execução triangular ao vivo · Motor 3 mempool (bloqueado) · calibrar/ligar arb em mainnet.
>
> O histórico abaixo (fases/sprints) é mantido como registro; o checklist pré-mainnet a seguir continua válido.
>
> ### ✅ Reconciliação 2026-06-18 — checkboxes `[ ]` que JÁ FORAM CONCLUÍDOS (mantidos como registro)
> Cruzamento tarefa × código: várias seções de implementação abaixo ainda mostram `[ ]` mas **estão FEITAS** no repo
> (confira no histórico do final + no código). Os checkboxes foram preservados como registro histórico — o que REALMENTE
> falta está no **checklist pré-mainnet**, nas **decisões abertas** e nas **Etapas C/D do OIE** + **mempool (Sprint 4/5)**.
> - **Fase 4c · Trilha 1** (workspace `monitor`, `executeLiquidation`, `IPool.liquidationCall`, fork tests) → ✅ `apps/monitor/*` + `ZeusLiquidator.sol` (executeLiquidation/Compound/Morpho + WithBribe) + `interfaces/aave/IPool.sol` + `ZeusLiquidator.fork.t.sol`.
> - **Fase 6.5 · Sprint 1** (Seamless + MIN_DEBT) → ✅ Seamless via multi-market do liquidator (`case 'seamless'`); `MIN_DEBT_USD` default já = 100.
> - **Fase 6.5 · Sprint 2** (Arbitrum + Optimism) → ✅ `chain-config/{arbitrum,optimism}.ts` + deploys Sepolia (ver `CLAUDE.md`).
> - **Sprint 3** (Compound III + Morpho + Moonwell) → ✅ (já marcado).
> - **Avalanche/Polygon chain-config** → ✅ `chain-config/{avalanche,polygon}.ts` existem (code-ready; deploy mainnet pendente).
> - **Subgraph Aave discovery** → ✅ no liquidator + `aave-discovery`.
>
> **Genuinamente pendente** (atualizado pós-merge 2026-06-22): deploy mainnet dos contratos · capital/multisig/audit (decisões) · DRY_RUN 2 semanas · OIE Etapa D (parcial — 3 de 8 dashboards) + Etapa B detector (baixa prio) · execução triangular ao vivo + calibrar/ligar arb (Motor 2) · mempool premium (Motor 3/JIT ao vivo) · itens do checklist pré-mainnet. _(Etapa C OIE e Motor 2 executor já FEITOS.)_

---

## ✅ CAMADA OIE + DRY_RUN INTELLIGENCE (2026-06-15)

Camada **OIE (Opportunity Intelligence Engine)** entregue — scoring + ledger persistente + EV gates ligados nos motores que
dispatcham. Documento vivo: [`docs/OIE_PROGRESS.md`](./docs/OIE_PROGRESS.md).

### Etapa A — scoring + ledger DuckDB ✅
- [x] `packages/execution-utils/src/scoring/` — Opportunity Score universal (`opportunityScorer.ts`: `evUsd` = P(sucesso) × lucro
      líquido + score composto [0,1]), Protocol/Pool/Token Score (`dimensionScorer.ts`, puro), agregação histórica do DuckDB
      (`dimensionStatsQuery.ts` → `DimensionStats`).
- [x] Ledger DuckDB (`timeseriesStore`) — fix de `timestamp` Unix ms (era INT32 e estourava → BIGINT).
- [x] Testes novos: `opportunityScorer.test.ts` (15) + `dimensionScorer.test.ts` (10) + `dimensionStatsQuery.test.ts` (8).

### Etapa B — EV gates nos motores ✅
- [x] **Backrun** — EV competitor-aware via nível de **gas war** (`GAS_WAR_PRIORS`), gate opt-in `MIN_OPPORTUNITY_EV_USD`
      (default desligado), score emitido em `backrun.opportunity_found` → ledger.
- [x] **Liquidator** — EV gate **ciente de OEV**: helper aplica "OEV haircut" por protocolo (lucro realista = nominal × (1 −
      recapture)), plugado nos 4 runners (Aave/Compound/Morpho/Moonwell) logo após o `decision`. SEMPRE loga o score pós-OEV
      (observabilidade); gate opt-in `MIN_OPPORTUNITY_EV_USD` → quando ligado, o bot **foca em Morpho** naturalmente.
      Defaults calibráveis em `OEV_RECAPTURE_PRIORS` (Morpho 0% · Aave/Compound ~85% · Moonwell ~99%; forks de Aave tratados como abertos).
- [ ] Etapa B — **detector** (ranking na descoberta, radar passivo) — baixa prioridade.

### DRY_RUN intelligence ✅
- [x] **Detector** (`apps/detector`) e **MIS scanner** (`apps/mis-scanner`) gravam oportunidades observadas no ledger DuckDB
      (categorias `arb_observed` / `mis_observed`) — antes só logavam.
- [x] `execution-utils`: `buildObservationEvent`, `resolveIntelligenceDbPath` (honra `INTELLIGENCE_DB_PATH`),
      `queryTopOpportunityPairs` + `attachAndRankPairs` (ranking de pares, unificação cross-motor via ATTACH — DuckDB single-writer).
- [x] Liquidator/backrun honram `INTELLIGENCE_DB_PATH` (volume persistente).
- [x] Detector ligado na **varredura dinâmica** (`getTargetPairsForChain`): consome pares curados + auto-targets do
      `discovery-scraper`. Sem arquivo de auto-targets, cai nos curados (idêntico ao anterior).

### Deploy Fly.io ✅
- [x] `Dockerfile` + `deploy/fly/*.toml` (volume persistente obrigatório pro ledger DuckDB single-writer).
      Guia: [`docs/refs/fly-deploy.md`](./docs/refs/fly-deploy.md).

### 🎯 Achado OEV → reorientação estratégica do liquidator
A pesquisa de mercado mostrou que **liquidação na Base está se fechando por OEV capture**: Aave V3 (~85% Chainlink SVR),
Compound III (~85% SVR/Atlas), Moonwell (~99% MEV tax on-chain). **Morpho Blue (0% recapture) é o único edge real** — por isso o
liquidator agora prioriza Morpho via gate EV pós-OEV. Ver [`docs/refs/competitive-landscape.md`](./docs/refs/competitive-landscape.md)
e [`docs/refs/morpho-profit-projection.md`](./docs/refs/morpho-profit-projection.md).

### Etapas C/D — pós-DRY_RUN
- [x] **Etapa C** — auto-prioritization + thresholds adaptativos (loop de feedback via `pnlReconciler`/`failureCollector`)
      — **FEITO opt-in** (`ADAPTIVE_THRESHOLDS_ENABLED=false` default).
- [~] **Etapa D** — dashboards Grafana — **parcial**: `DimensionMetricsExporter` (bridge DuckDB→Prometheus) + **3 dashboards**
      (operations/performance/rankings) prontos; meta original era 8 (`prometheusExporter` já existia).

**Verificação (pós-merge 2026-06-22):** `pnpm typecheck` **13/13 workspaces** verdes · contratos **78/79 unit Foundry** (1 skip)
+ fork verde · **~404 testes TS** (vitest; `execution-utils` **336/336**).

---

## ⚠️ PRÉ-ATIVAÇÃO MAINNET — CHECKLIST OBRIGATÓRIO

**ANTES** de mudar `LIQUIDATOR_MODE` pra `mainnet` ou submeter qualquer tx real em chain de produção, validar TODOS os itens:

### Thresholds estratégicos (config.ts / .env)
- [ ] `MIN_DEBT_USD >= 100` (defaults prod, NÃO os baixos de calibração)
- [ ] `MIN_LIQUIDATION_PROFIT_USD >= 5`
- [ ] `HF_AT_RISK_THRESHOLD <= 1.05`
- [ ] `HF_LIQUIDATABLE_THRESHOLD <= 1.0`
- [ ] `MAX_SLIPPAGE_BPS` calibrado com 2 semanas de DRY_RUN data
- [ ] `AAVE_CLOSE_FACTOR <= 0.5` (Aave limit imutável)
- [ ] `POOL_LIQUIDITY_CAP_PCT <= 0.1` (10% liquidez pool max)

### Circuit breakers on-chain (via owner txs nos contratos v8 split — ZeusLiquidator / ZeusArbExecutor / ZeusMoonwellLiquidator)
- [ ] `setMaxTradePerToken(USDC, X)` definido — NÃO confiar no fallback `maxTradeWei`
- [ ] `setMaxTradePerToken(WETH, X)` definido
- [ ] `setMaxTradePerToken(cbBTC/WBTC, X)` definido (se vai operar)
- [ ] `maxTradeWei` global setado como ceiling razoável
- [ ] Owner = multisig Safe Wallet (NÃO carteira solo)
- [ ] Operator = bot wallet com chave em hardware/MPC (NÃO `.env` em prod)

### Validações operacionais
- [ ] 2 semanas mínimo de DRY_RUN em Base mainnet com 0 incidentes
- [ ] Slippage real (do calibration log) está dentro do MAX_SLIPPAGE_BPS configurado
- [ ] Profit real médio (event LiquidationExecuted) está positivo após gas
- [ ] Discord/Telegram webhook ativo pra alertas
- [ ] Tenderly alerts configurados em events suspeitos
- [ ] Kill switch testado (revive/kill ciclo completo)

### Infra
- [ ] RPC Alchemy Growth (ou equivalente pago) — NÃO confiar em free tier
- [x] Fly.io health-check + restart automático — `/healthz` + `/readyz` via `startHealthServer` (execution-utils/health) ligado em
      liquidator + backrun-engine + discovery-scraper; configs `deploy/fly/*.toml` com volume persistente. Falta só ligar o RPC pago.
- [ ] Backup operator wallet com fundos pra gas
- [ ] Logs persistidos (não só stdout)

### Audit (opcional mas recomendado depois do primeiro lucro)
- [ ] Bug bounty Immunefi quando TVL > $50k (ver pendência #N)
- [ ] Audit Trail of Bits / Spearbit quando lucro acumulado > $10k

**Princípio inviolável**: nada dispatcheado em mainnet sem checklist verde. Se 1 item falhar, voltar pra DRY_RUN até resolver.

---

## 🚨 GAPS CRÍTICOS — INVENTÁRIO 2026-05-25

Lógicas/otimizações faltantes identificadas em scan proativo de produção. Sem essas, bot funciona em testnet mas quebra em mainnet (silenciosa ou caramente). Organizado por criticidade.

### 🔴 CRÍTICO — Bloqueadores pra mainnet real

- [x] **Daily loss limit** ✅ (entregue 2026-05-26) — `apps/liquidator/src/pnlTracker.ts` com rolling window 24h, persistência JSONL append-only, hooks no dispatcher (tx revertida = loss USD, confirmed com net negativo = loss), gate pre-dispatch nos pipelines Aave+Compound, on-chain `triggerKillSwitchOnChain` helper (idempotente, modo-aware), config `DAILY_LOSS_LIMIT_USD` (default 100) + `PNL_LOG_FILE` + `AUTO_KILL_SWITCH_ENABLED`. Boot carrega histórico 24h, log de stats por tick. **9/9 typecheck verde + smoke boot OK**.
- [x] **Cooldown após N falhas seguidas** ✅ (entregue 2026-05-26) — `apps/liquidator/src/failureTracker.ts` com contador de falhas consecutivas + cooldown timer. Hooks dispatcher: revert on-chain conta como falha, net negativo conta, success (net positivo) reseta contador. Pre-dispatch gate em ambos pipelines (Aave + Compound) — durante cooldown, retorna `reverted_pre_dispatch` com tempo restante. Após cooldown expira, contador zera e bot retoma. Config: `MAX_CONSECUTIVE_FAILURES` (default 3) + `COOLDOWN_DURATION_SEC` (default 300s = 5min). Log de tick mostra `fails=X/Y` + cooldown status. **9/9 typecheck + smoke boot OK**.
- [x] **Position deduplication** ✅ (entregue 2026-05-26) — `apps/liquidator/src/positionDedup.ts` com Map<positionKey, status> + TTL. 3 estados: `pending` (tx submetida, aguardando receipt), `confirmed` (tx confirmou, bloqueia retry por TTL), `failed` (tx reverteu, bloqueia retry). Chave composta: `${chain}:aave-v3:${borrower}` (Aave) ou `${chain}:compound-v3:${comet}:${borrower}` (Compound). Dispatcher chama `markPending` ao submit, `markConfirmed/markFailed` pós-receipt. Pipeline gates abortam pre-dispatch com motivo `dedup blocked: pending há Xs`. Config: `DEDUP_PENDING_TIMEOUT_SEC` (default 300s) + `DEDUP_RECENT_TTL_SEC` (default 300s). Log de tick mostra `dedup=N (p=X c=Y f=Z)`. **9/9 typecheck + smoke boot OK**.
- [x] **Gas reserve monitoring + alerta** ✅ (entregue 2026-05-26) — `apps/liquidator/src/gasReserveTracker.ts` com 2 thresholds (WARN/CRITICAL). Check via `client.getBalance(account)` no boot + a cada tick (60s). Anti-spam: só loga alerta quando muda status (não repete a cada tick). Status: `ok`/`warn`/`critical`/`unknown` (em dryrun sem wallet). Gate pre-dispatch nos 2 pipelines: se `shouldBlockDispatch()` retorna true (critical + flag), aborta dispatches. Config: `GAS_RESERVE_WARN_ETH` (default 0.05 ETH = ~$150) + `GAS_RESERVE_CRITICAL_ETH` (default 0.01 ETH = ~$30) + `BLOCK_DISPATCH_ON_CRITICAL_GAS` (default true). Log do tick mostra `gas=<status> <balance>ETH`. **9/9 typecheck + smoke boot OK**.
- [x] **EIP-1559 gas pricing correto** ✅ (entregue 2026-05-26) — `apps/liquidator/src/gasOracle.ts` com `GasOracle` class. Lê `eth_feeHistory` (4 blocos) cacheado por blockNumber — 1 RPC por bloco, não por tx. Calcula `maxFeePerGas = baseFee * MULTIPLIER + priorityFee` + `maxPriorityFeePerGas = config`. Default conservador pra Base (priority 0.001 gwei, multiplier 2x absorve spike de 100%). Dispatcher passa fees explicitamente pro `sendTransaction` em vez de deixar viem usar default. Config: `GAS_PRIORITY_FEE_GWEI` (default 0.001) + `GAS_MAX_FEE_MULTIPLIER` (default 2). Fallback em caso de falha do `eth_feeHistory`. Cache de gasPrice por bloco (anotação Humberto) — cobre 1 RPC ao invés de N tx. **9/9 typecheck + smoke boot OK**.
- [x] **Health endpoint HTTP** ✅ (entregue OIE/DRY_RUN) — `startHealthServer` em `packages/execution-utils/src/health/healthServer.ts` expõe `/healthz` (200 se loop ativo) + `/readyz` pro UptimeRobot. Ligado em liquidator (`HEALTH_SERVER_ENABLED`/`HEALTH_SERVER_PORT`/`HEALTH_SERVER_HOST`), backrun-engine e discovery-scraper. Fly.io restart automático coberto.
- [x] **Discord/Telegram webhook alerts** ✅ (entregue 2026-05-26) — Sistema completo de event bus + sinks externos. `apps/liquidator/src/eventBus.ts` (emit/subscribe tipado, fire-and-forget paralelo), `events.ts` (11 tipos discriminated union — boot, shutdown, tx.confirmed/reverted, kill switch, cooldown, gas alert/recovered, tick), `alerting/discordSink.ts` (formata embeds visuais com cores/emojis por severidade), `alerting/genericWebhookSink.ts` (POST JSON raw pra qualquer URL — Telegram, mini server, n8n, futuro WebSocket gateway). Filtros por severidade configuráveis (Discord default warn+critical pra evitar spam; generic default tudo). Hooks: dispatcher emite tx.confirmed/reverted_on_chain/reverted_pre_dispatch; index emite boot + tick_completed. Config: `DISCORD_WEBHOOK_URL` + `GENERIC_WEBHOOK_URL` + `DISCORD_SEVERITIES` + `GENERIC_SEVERITIES`. **9/9 typecheck + smoke boot OK** (sem URL logs "Nenhum sink configurado"). Arquitetura pronta pra futuro mobile app conectar via WebSocket consumindo mesmo EventBus.
- [x] **Stale position re-check pré-dispatch** ✅ (entregue 2026-05-26) — `apps/liquidator/src/staleCheck.ts` com `isAaveStillLiquidatable` (lê HF via `getUserAccountData` e compara com `HF_LIQUIDATABLE_THRESHOLD` em wei) + `isCompoundStillLiquidatable` (chama `Comet.isLiquidatable` que é definitivo). Hook no pipeline DEPOIS do simulator (sim OK) e ANTES do dispatch. Skipa em DRY_RUN (sem submit real, não precisa). Custo: +50ms latência por dispatch real. Fail-open: se RPC falhar, assume liquidable e prossegue (não bloqueia oportunidade por bug de infra). Config: `STALE_CHECK_ENABLED` (default true). Log: `⏭️  Stale position descartada: HF 1.0245 >= threshold 1.0` quando outro bot já liquidou. **9/9 typecheck + smoke boot OK**.

**Total crítico:** ~12-18h (~2-3 sessões)

### 🟡 IMPORTANTE — Bot opera sem, mas perde capture rate ou eficiência

- [x] **Cache eth_gasPrice por bloco** ✅ (entregue 2026-05-26 junto do EIP-1559) — `gasOracle.ts` cacheia `eth_feeHistory` por `blockNumber` (1 RPC por bloco, não por tx).
- [ ] **Gas bumping dinâmico** (anotação Humberto) — mempool ve outro bot tentando mesma liquidation → subir `maxPriorityFee` em real-time. Requer mempool (Caminho B). ~3-5h
- [x] **Multi-collateral positions evaluation** ✅ — discovery/calculator agora avaliam os pares (collateral_i, debt_j) e escolhem max profit em vez de só "top-1 por wei" (M-01 do audit).
- [ ] **Partial liquidation amount otimization (Aave)** — não sempre 50% close factor. Às vezes 25% gera mais profit (pool raso). Calculator deveria sample isso também. ~3h
- [x] **Multi-path swaps** ✅ — `multiHopQuoter` (dex-adapters) + `buildMultiHopIntermediates` no liquidator pipeline (flag `MULTI_HOP_SWAPS_ENABLED`); contrato suporta N steps. (Detector fanout ainda single-hop — esse continua pendente.)
- [ ] **Auto-claim COMP rewards** — `Comet.absorb()` acumula COMP no contrato. Sweep periódico via `rescueToken` OR adicionar função dedicada. ~2h
- [ ] **Graceful shutdown** — SIGTERM aguarda tx pendentes confirmarem antes de matar processo. Evita nonce corruption. ~2h
- [x] **Tx replay log persistente** ✅ (coberto) — ledger DuckDB (`intelligence`) + `pnlReconciler` (JSONL de reconciliações) + `failureCollector` (JSONL de failures) persistem decisões/resultados pra post-mortem.

### 🟢 RECOMENDÁVEL — Produção robusta de longo prazo

- [ ] **Per-protocol cap** — `MAX_EXPOSURE_AAVE_USD` / `_COMPOUND` / `_MORPHO` separados. Concentration risk. ~1h
- [ ] **Per-chain cap** — não colocar 80% capital em 1 chain. ~1h
- [ ] **Anomaly detection** — profit médio diário cair 50% = alerta (oracle attack? bug? mudança protocolo?). ~3h
- [ ] **Reorg handling** — Base pode reorgar (raro). Reconciliar tx que parecia confirmada mas sumiu. ~4-6h
- [ ] **Multi-wallet rotation** — 2-3 bot wallets pra evitar nonce contention em volume alto. ~3h
- [ ] **Key rotation procedure** — a cada 6 meses, swap key (procedural). ~1h
- [ ] **On-chain audit log** — guardar commit hash do código ativo em storage slot pra comprovar versão. ~2h

### 🧠 STRATEGY GAPS — descobertos no scan proativo

- [x] **Race condition cross-protocol** ✅ (mitigado) — `apps/liquidator/src/staleCheck.ts` re-checa HF on-chain ANTES do submit (`isAaveStillLiquidatable`/`isCompoundStillLiquidatable`), aborta se não é mais liquidável. Execução atômica via flashloan + `minProfitWei` no contrato cobre o resto.
- [x] **Oracle staleness sanity check** ✅ — `packages/execution-utils/src/oracle/chainlinkStaleness.ts` (lê `updatedAt` do Chainlink e hesita se oracle freezado/stale), ligado no pipeline do liquidator.
- [x] **Block timestamp drift detection** ✅ — `packages/execution-utils/src/health/blockStalenessCheck.ts` (sanity check de block staleness / timestamps fora de ordem).
- [x] **Pause detection upstream** ✅ — `packages/execution-utils/src/protocols/pauseDetector.ts` + `autoPauseManager.ts`: antes de submeter, lê estado de pausa do protocolo (Aave/Compound) e aborta se pausado. Ligado no pipeline.
- [x] **Fee-on-transfer / token safety** ✅ — sistema de token safety no `discovery-scraper` (GoPlus: honeypot/tax/mintable em `sources/tokenSafety.ts` + `filters/tokenSafetyFilters.ts`) + `packages/execution-utils/src/arb` (arbTokenSafety, com testes). Filtra tokens tóxicos antes de entrarem no universo de pares.

### 📝 Ordem sugerida de implementação (próximas 4-6 sessões)

```
Sessão A (CRÍTICOS bloqueadores parte 1):
  - Daily loss limit + cooldown após falhas
  - Position dedup
  - Discord webhook alerts

Sessão B (CRÍTICOS bloqueadores parte 2):
  - EIP-1559 gas pricing
  - Gas reserve monitoring
  - Health endpoint HTTP
  - Stale position re-check pré-dispatch
  - Cache eth_gasPrice por bloco

Sessão C (Sprint 3 Morpho — protocolo missing):
  - Pipeline TS pra Morpho
  - IRM enrichment on-chain

Sessão D (IMPORTANTES):
  - Multi-collateral evaluation
  - Partial liquidation optimization
  - Pause detection upstream
  - Oracle staleness check

Sessão E+ (depois primeira semana mainnet):
  - Gas bumping dinâmico (requer mempool — Sprint 4)
  - Multi-path swaps
  - Anomaly detection
  - Reorg handling
```

---

## ⚡ EXPANSÃO MOTORES DE LUCRO — 3 MOTORES DESCORRELACIONADOS

**Decisão Humberto 2026-05-25**: ZEUS precisa de no mínimo **3 motores de lucro independentes** rodando em paralelo pra eliminar risco de "mercado calmo prolongado". Infra mempool ($199-499/mês) aceita como custo necessário pra destravar #2 e #3.

### Tese de descorrelação

| Motor | Ganha quando... | Mercado favorável |
|---|---|---|
| **#1 Liquidations** | Mercado em crash | Volatilidade ↑ |
| **#2 JIT Liquidity** | Volume DEX alto | Bull run, alto volume |
| **#3 Backrun dislocation** | Movimento brusco | Volatilidade súbita |

**Garantia:** ZEUS fatura em **qualquer cenário** porque os 3 motores são descorrelacionados.

### Sprint 4 — JIT Liquidity Uniswap V3 (MOTOR #2)

**Quando:** após Sprint 3 Morpho + 2 semanas DRY_RUN positivo do motor #1.

**Como funciona:**
1. Mempool detecta swap grande chegando (>$50k em UniV3)
2. Bot pre-deposita liquidez concentrada exatamente no tick que vai ser atravessado
3. Capital vem de flashloan (Aave V3) — segue princípio capital-light
4. Swap acontece, fees do tick alvo ficam com o bot
5. Bot remove liquidez no próximo bloco + repaga flashloan
6. Profit = fees capturadas − flashloan fee − gas

**Por que vale:**
- ✅ Edge documentado em mainnet ETH (vários bots fazem)
- ✅ Capital-light (flashloan da liquidez)
- ✅ **Independente de liquidations** — receita em mercado calmo
- ✅ Receita correlacionada com volume DEX (mais estável que crashes)

**Infra requerida:**
- Mempool watching: Alchemy Mempool API ($199/mês) ou Blocknative ($499/mês)
- Latência crítica (<200ms) — bot dedicado próximo ao sequencer Base

**Tarefas técnicas estimadas (~5-7 dias):**
- [ ] Novo workspace `apps/jit-liquidity` (separado do liquidator pra não acoplar)
- [ ] Mempool subscription (Alchemy WSS) + decoder de swap calldata
- [ ] Pre-computation: dado swap em mempool, calcular tick alvo + liquidez ótima
- [ ] Smart contract: adicionar função `executeJitLiquidity` (mint position + burn position atômico) — nos contratos v8 split (provável `ZeusArbExecutor` ou contrato dedicado; não há mais `ZeusExecutor` monolítico)
- [ ] Pipeline: mempool detect → calcular → encoded tx → submit competitivo
- [ ] Cache de pool states em memória (não pode esperar RPC pra cada decisão)
- [ ] Testes fork com swap real simulado

**Receita estimada:** $20-100/dia em Base, $50-500/dia em mainnet ETH (futuro)

### Sprint 5 — Backrun de Dislocation (MOTOR #3)

**Quando:** após Sprint 4 estabilizado (1 mês de receita JIT consistente).

**Como funciona:**
1. Mempool detecta swap grande chegando (>$100k)
2. Bot pre-calcula: pool ficará X% dislocated post-swap
3. Bot prepara tx oposta com flashloan (compra do lado barato, vende no lado caro)
4. Submete pra próximo bloco (posição #2 na fila)
5. Captura spread de retorno ao equilíbrio (geralmente 0.1-0.5%)

**Por que vale:**
- ✅ Capital-light
- ✅ Totalmente independente do #1 e #2
- ✅ Receita em volatilidade (movimento brusco em qualquer direção)
- ✅ Reusa mempool subscription do Sprint 4 (custo zero adicional de infra)

**Tarefas técnicas estimadas (~5-7 dias):**
- [ ] Adicionar contrato `executeBackrunArb` (similar a executeFlashloanArbitrage mas multi-pool aware)
- [ ] Detector de "swap impact" — dado calldata de swap em mempool, calcular novo preço pós-swap
- [ ] Comparison entre pools (UniV3 fee tiers diferentes, Aerodrome volatile vs stable, etc)
- [ ] Pipeline: detect → impact calc → arb decision → submit
- [ ] Race condition handling (outros bots tentando o mesmo backrun)

**Receita estimada:** $30-200/dia (varia muito com volume)

### Otimizações dos motores #1 (DE GRAÇA com mempool já paga)

Estes não são motores separados — são amplificadores que viram automáticos uma vez que mempool está ativa:

#### Liquidations PRE-EMPTIVAS
- Mempool detecta tx que vai mover HF (borrow/withdraw/oracle update)
- Bot pre-calcula novo HF
- Se cruzar threshold → submete liquidation no MESMO bloco
- **Capture rate em crashes: 5-10x** vs polling
- Implementação: ~3 dias após Sprint 4

#### Capture-race awareness
- Mempool ve outros bots tentando mesma oportunidade
- Bot ajusta gas price OR desiste antecipadamente
- Reduz tx revertidas em 30-50%
- Implementação: ~2 dias após Sprint 4

#### Oracle update prediction
- Chainlink updates aparecem em mempool antes do bloco
- Liquidator pre-monta lista de positions afetadas
- Submete batch logo após confirmação
- Implementação: ~2 dias após Sprint 4

### Estratégias FUTURAS (com mais código, mesma infra mempool)

| Estratégia | Esforço | Receita estimada |
|---|---|---|
| Cross-pool fee tier arbitrage UniV3 | ~1 sem | $10-80/dia |
| Aerodrome ve(3,3) intra-DEX (Base only) | ~1 sem | $5-50/dia |
| Cross-protocol oracle arbitrage | ~2 sem | $20-150/dia |
| Compound COMP rewards harvest | ~2 dias (side-effect do #1) | $5-30/dia automático |

### Orçamento expandido Caminho B (após Sprint 4)

| Item | Custo/mês |
|---|---|
| Alchemy Growth (RPC) | $49 |
| Alchemy Mempool API | $199 |
| Fly.io 24/7 multi-process | $50-80 |
| Tenderly Pro | $50 |
| Reserva | $30 |
| **Total** | **$378-408/mês** |

ROI esperado: receita base $5k+/mês (motores #1+#2+#3) cobre infra com folga. Princípio capital-light preservado (45% lucro pra reinvestimento conforme `project-zeus-evm-capital-principle`).

---

## 🌐 EXPANSÃO MULTI-CHAIN — ROADMAP DOCUMENTADO

Chains alvo pra expansão pós-validação 2 semanas DRY_RUN. Ordem de implementação sugerida (mas decisão final fica pra após observar resultados das chains atuais).

### 🥇 Avalanche C-Chain — PRÓXIMA EXPANSÃO RECOMENDADA

**Status:** anotada como prioritária (decisão Humberto 2026-05-25). Implementar **após Morpho Sprint 3** + 2 semanas DRY_RUN positivo.

**Por que faz sentido pro ZEUS:**

| Benefício | Detalhe quantitativo |
|---|---|
| **+500-800 borrowers Aave V3** | Cobertura cresce ~60-70% acima do Base+Arb+OP atual |
| **TVL Aave V3 Avalanche** | ~$300M (estagnado mas estável, não em risco de morte) |
| **Gas barato nativo** | ~$0.01-0.05 por tx → liquidações pequenas ($5-50) ainda mais viáveis |
| **Stack já cobre** | Mesma arquitetura Aave V3 multi-chain do Sprint 1, zero refactor |
| **Concorrência menos saturada** | Bots top focam mainnet ETH/Arb/Base; Avalanche tem menos bots competitivos |
| **Block time ~1-2s** | Compatível com nosso polling 60s (Caminho A) |
| **Positions em assets locais** | sAVAX, JOE, BENQI tokens — bots multi-chain genéricos costumam ignorar |
| **EVM equivalent (C-Chain)** | Sem refactor de código, só chain config |

**Por que NÃO é o primeiro alvo de expansão:**
- Compound III: ❌ não existe em Avalanche (perderíamos Sprint 2 pipeline)
- Morpho Blue: ❌ sem volume real (perderíamos Sprint 3 futuro)
- TVL Aave estagnado: capital crypto está migrando pra L2s ETH-aligned

**Custo de implementação:** ~45min código + 1h teste

**Tarefas técnicas (quando ativar):**
- [x] Adicionar `packages/chain-config/src/avalanche.ts` com endereços canônicos: ✅ (arquivo existe + `polygon.ts`; code-ready — deploy mainnet ainda pendente)
  - Aave V3 Pool: `0x794a61358D6845594F94dc1DB02A252b5b4814aD` (mesmo de Arb/OP)
  - PoolAddressesProvider: `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb`
  - Aave Data Provider: `0x50ddd0Cd4266299527d25De9CBb55fE0EB8dAc30`
  - Uniswap V3 (se disponível) OR usar TraderJoe/Pangolin como DEX alternativo
- [ ] Adicionar entrada em `POOL_ADDRESSES_PROVIDER_BY_CHAIN` (chainId 43114)
- [ ] Subgraph ID Aave V3 Avalanche (pesquisar oficial Messari/Aave)
- [ ] `AVALANCHE_RPC_HTTP` no `.env.example`
- [ ] `EXECUTOR_CONTRACT_ADDRESS_AVALANCHE` (vazio até deploy)
- [ ] Deploy ZeusExecutor v6+ em Avalanche Fuji (testnet) → revive → setOperator
- [ ] Deploy ZeusExecutor em Avalanche mainnet (após observação 2 sem testnet)
- [ ] Validar DRY_RUN em Avalanche mainnet observando 2 sem antes de dispatch real
- [ ] Considerar TraderJoe/Pangolin como alternativa DEX pro swap (Uniswap V3 em AVAX pode ter pools rasos pra alguns pares)

**Gatilho pra começar:**
- ✅ Sprint 3 Morpho entregue + estável
- ✅ 2 semanas DRY_RUN positivo em Base mainnet
- ✅ Liquidator dispatching real em testnet Sepolia sem incidente
- ✅ Decisão consciente do Humberto baseada nos dados de calibração

### 🥈 Polygon PoS — VIÁVEL mas baixa prioridade

**Status:** documentada como possível, mas não recomendada como próxima.

**Trade-offs (vs Avalanche):**
- ✅ TVL Aave maior (~$1-2B)
- ✅ Mais borrowers ativos (1-3k)
- ❌ Mercado SATURADO de bots maduros (desde 2022)
- ❌ Sem Compound III nativo (idem Avalanche)
- ❌ Sem Morpho com volume
- ❌ Polygon perdendo share relativa pra L2s ETH-aligned

Avaliar caso Avalanche prove receita consistente, considerar Polygon como expansão #3 pós-Avalanche.

### 🥉 Outras chains (mapeadas mas baixa prioridade)

| Chain | Aave V3 | Compound III | Morpho | Veredito |
|---|---|---|---|---|
| **BSC** | ✅ ~$200M TVL | ❌ | ❌ | Oracle history problemático, evitar até post-receita |
| Polygon zkEVM | 🟡 Pequeno | ❌ | ❌ | Cedo demais |
| Scroll | 🟡 Pequeno | ❌ | ❌ | Cedo demais |
| Linea | 🟡 Pequeno | ❌ | ❌ | Cedo demais |
| Mantle | 🟡 Pequeno | ❌ | ❌ | Cedo demais |

---



Lista detalhada do que está pronto e do que falta para **pleno funcionamento** (do estado atual até bot rodando em mainnet Base com capital real).

**Última atualização:** 2026-06-15 (Sprint 3 completo · contratos v8 split · flashloan multi-fonte · camada OIE + DRY_RUN ledger · ver "ESTADO ATUAL" no topo). Bloco abaixo preserva o histórico das Fases 0-5a como registro.

> Documento vivo. Marcar `[x]` quando concluir, não remover (histórico preservado).

---

## ✅ Concluído

### Fase 0 — Setup inicial (2026-05-22) ✅

- [x] Pasta `C:\Users\user\zeus-evm\` + `git init` + repo `github.com/Opresida/zeus-evm`
- [x] Estrutura monorepo: `contracts/`, `apps/{detector,backtest,monitor}/`, `packages/{chain-config,dex-adapters,strategy,shared-types}/`
- [x] `package.json` root + `pnpm-workspace.yaml` com catalog (viem, vitest, pino, zod, tsx)
- [x] `.gitignore` (Node, Foundry, .env, broadcast/, lockfiles incorretos)
- [x] `.env.example` documentado + `.env` local com chave testnet dedicada
- [x] `contracts/foundry.toml` (solc 0.8.27, via_ir, optimizer 1M runs, yul, fuzz config)
- [x] `contracts/remappings.txt` (OpenZeppelin, Uniswap V3, Aave V3 local, forge-std)
- [x] 7 docs canônicos criados (README, CONTEXT, PROJECT_CONTEXT, ARCHITECTURE, TODO, CONTRACTS, CLAUDE)

### Fase 1 — Smart contracts core (2026-05-22) ✅

- [x] `ZeusExecutor.sol` completo (280 LOCs):
  - [x] Ownable2Step + ReentrancyGuard + Pausable + SafeERC20 + custom errors
  - [x] Kill switch fail-safe (constructor inicia _killed=true)
  - [x] `executeArbitrage(ArbitrageParams)` com validações + circuit breaker maxTradeWei
  - [x] `executeFlashloanArbitrage(asset, amount, params)` + callback `executeOperation`
  - [x] `kill()` / `revive()` / `pause()` / `unpause()` / `setOperator()` / `setMaxTradeWei()` / `rescueToken()`
  - [x] Receive ETH
- [x] Interfaces: `IZeusExecutor`, `IPool` (Aave), `IFlashLoanSimpleReceiver`
- [x] Libraries inline (gas-optimized):
  - [x] `UniswapV3Lib` — SwapRouter02 via `exactInputSingle` (extraData = fee tier)
  - [x] `AerodromeLib` — Router via `swapExactTokensForTokens` (extraData = stable+factory)
- [x] **18 unit tests** + fuzzing config (`forge test --fuzz-runs 100000`)
- [x] **4 fork tests** cross-DEX (UniV3 swap real, multistep, InsufficientProfit revert)
- [x] **5 fork tests** flashloan (Aave V3 real, callback, InvalidCaller, TradeTooLarge)

### Fase 2 — Detector off-chain DRY_RUN (2026-05-22) ✅

- [x] `apps/detector/src/config.ts` — load `.env` + Zod schema (20+ vars, optional* preprocessors)
- [x] `apps/detector/src/logger.ts` — pino structured (JSON em prod, pretty em dev)
- [x] `apps/detector/src/mempool/blockSubscription.ts` — WSS Alchemy + retry + polling fallback
- [x] `packages/chain-config`:
  - [x] BASE_MAINNET (Aave/UniV3/Aerodrome/BaseSwap/Compound/Morpho addresses)
  - [x] BASE_SEPOLIA (Aave V3 + UniV3 — sem Aerodrome em testnet)
  - [x] BASE_TARGET_PAIRS (5 pares: WETH/USDC, cbETH/WETH, USDC/USDT, WETH/AERO, USDC/DAI)
- [x] `packages/dex-adapters`:
  - [x] `quoteUniswapV3` via QuoterV2 (simulateContract)
  - [x] `quoteAerodrome` via Router.getAmountsOut
  - [x] **6 vitest tests** contra Base mainnet (gap UniV3↔Aero validado em WETH/USDC)
- [x] `packages/strategy` (refactored 2026-05-22):
  - [x] `opportunities/crossDex.ts` — findCrossDexArb (N² combos forward+reverse)
  - [x] `opportunities/quoteFanout.ts` — parallel quotes across DEXs
  - [x] `opportunities/filters.ts` — min profit USD, slippage, gas, flashloan fee
  - [x] `executor/txBuilder.ts` — buildArbitrageCalldata + buildFlashloanCalldata
  - [x] `executor/simulator.ts` — eth_call + estimateGas + decode custom errors
  - [x] `executor/abi.ts` — ABI completa ZeusExecutor (funcs, events, errors)
- [x] `apps/detector/src/index.ts` — orquestração: WSS subscribe → scan 5 pares → filter → simulate (opt-in)
- [x] `apps/detector/src/smoke.ts` — script de diagnóstico (config + RPC + balance)

### Fase 3 — Flashloan integration (2026-05-22) ✅

- [x] `executeOperation()` callback Aave V3 com validações caller + initiator + profit
- [x] `executeFlashloanArbitrage()` chamando `IPool.flashLoanSimple`
- [x] Repay automático Aave + fee 0.05% via forceApprove
- [x] Fork tests passando contra Base mainnet
- [x] `simulator.ts` decoda `FlashloanRepayShortfall`, `InsufficientProfit`, `TradeTooLarge`, etc.
- [x] Integração no detector: simula arb após filter pass (sem submeter)

### Fase 4a — Backtest histórico (parcial, 2026-05-22) ✅

- [x] `apps/backtest/src/index.ts` — replay de N blocos com `findCrossDexArb`
- [x] Output JSON estruturado em `apps/backtest/runs/`
- [x] **Resultado: 0 oportunidades em 1000 blocos amostrados (5.5h Base mainnet)**
- [x] Conclusão: cross-DEX em blue chips Base não tem edge real em 2026 (MEV bots dominam)

### Fase 4b — Fork tests do caminho POSITIVO (2026-05-22) ✅

- [x] `contracts/test/fork/ZeusExecutor.profitArb.t.sol`:
  - [x] `test_WalletArb_GeneratesProfit_AfterPriceGap` — wallet arb com gap artificial → PASSA
  - [x] `test_FlashloanArb_GeneratesProfit_AfterPriceGap` — flashloan arb com gap artificial → PASSA
- [x] **Mecânica validada**: contrato executa arb 2-step (UniV3+Aerodrome), calcula profit, transfere pro receiver, repaga Aave
- [x] **27→29 testes Foundry passando**

### Fase 5a — Deploy testnet Base Sepolia (2026-05-22) ✅

- [x] `contracts/script/Deploy.s.sol` — script Foundry com chainId-based config (8453 mainnet, 84532 Sepolia)
- [x] Carteira testnet dedicada criada + fundada via faucet (0.0195 ETH Sepolia)
- [x] ZeusExecutor deployado em Base Sepolia: **`0xe48473d75805886ac4162b1304eab6b8f93c5faa`**
- [x] Contrato verified no Basescan: [sepolia.basescan.org/address/0xe48473...](https://sepolia.basescan.org/address/0xe48473d75805886ac4162b1304eab6b8f93c5faa)
- [x] Estado on-chain validado: isKilled=true (fail-safe), owner=carteira, AAVE_V3_POOL correto Sepolia, maxTradeWei=0.01 ETH
- [x] Bug evitado: 1º deploy pegou Aave mainnet address do `.env` → script corrigido pra usar chainId como source of truth

---

## ❌ Pendente

> "Pleno funcionamento" = bot rodando em mainnet Base com capital real, executando arbitragens em produção.

### 🟡 Fase 4c — Mix A+B em duas trilhas independentes (DECIDIDO 2026-05-23)

**Estratégia escolhida:** Liquidations (A) como motor previsível + Pares Longtail (B) como radar de upside esporádico.

**Princípio de blindagem:** construir e validar cada trilha **isoladamente em fork mainnet** antes de rodarem juntas em produção. Sem cross-contamination de risco.

#### Trilha 1 — Motor de Liquidações Aave V3 ✅ CONCLUÍDO (entregue 2026-05-23 — checkboxes abaixo = registro; ver ZeusLiquidator.sol + apps/monitor + apps/liquidator)

**Decisões consolidadas:**
1. **Protocolo:** Aave V3 only (Compound III + Morpho ficam pra fase de expansão — ver abaixo)
2. **Descoberta de positions:** Subgraph (The Graph) — opção A do plano original
3. **Execução:** 100% flashloan (capital próprio = $0)
4. **Infra:** caminho gradual em `docs/INFRA_EVOLUTION.md` — começamos no Estágio 0

**Tarefas técnicas:**

- [ ] Pesquisar Aave V3 Base Subgraph URL + schema (query users + HF)
- [ ] `apps/monitor/` (novo workspace pnpm):
  - [ ] `package.json` + `tsconfig.json`
  - [ ] `src/index.ts` — main loop: polling positions + WSS new blocks trigger
  - [ ] `src/protocols/aaveV3.ts` — leitura de positions via subgraph + cálculo HF
  - [ ] `src/healthFactor.ts` — engine HF off-chain (evita gás)
  - [ ] `src/liquidator.ts` — dispara execução quando HF < 1.0
  - [ ] `src/config.ts` — load env (similar ao detector)
  - [ ] `src/logger.ts` — pino structured
- [ ] Adicionar `executeLiquidation()` no ZeusExecutor.sol:
  - Recebe (user, collateralAsset, debtAsset, debtToCover, liquidationSwaps[])
  - Pega flashloan do debtAsset via Aave
  - No callback executeOperation:
    - Aave.liquidationCall(user, collateralAsset, debtAsset, debtToCover, false)
    - Swap colateral → debtAsset via DEXs (UniV3/Aerodrome)
    - Repay flashloan + 0.05% fee
    - Mantém profit residual em debtAsset
  - Emit LiquidationExecuted event
- [ ] Adicionar IPool.liquidationCall ao IPool.sol interface
- [ ] Fork tests com posições reais de Base mainnet (descobrir HF < 1.05 via subgraph)
- [ ] Redeploy ZeusExecutor em Base Sepolia com nova função
- Edge: 5-10% liquidation bonus, janela 1-3 blocos, não precisa competir em ms

---

### 🟡 Fase 6.5 — Plano de Expansão (4 sprints, decidido 2026-05-23)

**Contexto:** Aave V3 Base sozinho tem apenas ~123 borrowers ativos reais — insuficiente pra meta de $1/min. Plano de 4 sprints expande pra ~7.000+ borrowers monitorados (57x mais oportunidades).

---

#### Sprint 1 (~1 semana) — Maior alavanca rápida na Base ✅ SUPERADO (Seamless via multi-market do liquidator; MIN_DEBT_USD default já = 100)

- [ ] **Seamless Protocol** (fork Aave V3, reusa 95% do código!)
  - [ ] Pesquisar endereços Seamless Pool em Base + Sepolia
  - [ ] `apps/monitor/src/protocols/seamless.ts` — quase cópia de aaveV3.ts
  - [ ] Adicionar ao discoveryLoop em paralelo com Aave V3
  - [ ] Testar fork test reusando interface IPool
  - Estimativa: 2 dias
- [ ] **Reduzir MIN_DEBT_USD pra $20** (config .env)
  - Base tem gas baixo (~$0.10/tx), captura liquidations menores ainda lucrativas
  - Mudança trivial, captura ~3x mais oportunidades
  - Estimativa: 5 min
- [ ] Resultado esperado: 250-350 borrowers cobertos em Base (3x mais que hoje)

#### Sprint 2 (~1 semana) — Multi-chain primário ✅ CONCLUÍDO (Arbitrum + Optimism: chain-config/{arbitrum,optimism}.ts + deploys Sepolia)

- [ ] **Arbitrum One** (Aave V3, ~3-5k borrowers estimados)
  - [ ] `packages/chain-config/src/arbitrum.ts` (endereços Aave + UniV3)
  - [ ] Adaptar monitor pra rodar 1 instância por chain (env CHAIN_ID)
  - [ ] Validar liquidation fork test em Arbitrum mainnet
  - [ ] Deploy ZeusExecutor em Arbitrum (mesmo código)
  - Estimativa: 2-3 dias
- [ ] **Optimism** (Aave V3, ~1.5-3k borrowers)
  - [ ] `packages/chain-config/src/optimism.ts`
  - [ ] Deploy ZeusExecutor em Optimism
  - Estimativa: 1-2 dias
- [ ] Resultado esperado: ~5.000+ borrowers cobertos (40x mais)

⚠️ Caveat: chains maiores têm mais competição de liquidation bots. Profit por liquidação menor mas frequência muito maior.

#### Sprint 3 (~2 semanas) — Protocolos extras ✅ CONCLUÍDO

- [x] **Compound III** (Comet) em Base + Arbitrum ✅
  - [x] `apps/monitor/src/protocols/compoundV3.ts` + pipeline TS completo em `apps/liquidator/src/protocols/compound/`
  - [x] Compound usa `absorb()` em vez de `liquidationCall` — interface diferente (tratado)
  - [x] Liquidação Compound nos contratos v8 split (não mais função única no ZeusExecutor monolítico) — `ZeusLiquidator.sol`
- [x] **Morpho Blue** em Base ✅
  - [x] `apps/monitor/src/protocols/morpho.ts` + pipeline TS Morpho (discovery + calculator + builder + simulator + IRM enrichment on-chain)
  - [x] Markets isolados (mais complexo que Aave/Compound) — tratado
  - [x] Liquidação via `liquidate()` na MarketParams específica
- [x] **Moonwell** (fork Compound) em Base ✅
  - [x] `apps/monitor/src/protocols/moonwell.ts` + pipeline + contrato dedicado `ZeusMoonwellLiquidator.sol`
- [x] Resultado: Motor 1 cobre 5 protocolos (Aave/Compound/Morpho/Seamless/Moonwell). ⚠️ Achado OEV reorientou o foco pra Morpho
      (único com recapture 0% na Base) — ver seção OIE no topo.

#### Sprint 4 (futuro, após Estágio 2 infra ~$300-600/mês)

- [ ] **Mempool watching** em Base + Arbitrum
  - [ ] Alchemy Mempool Subscriptions ($199/mês) ou Blocknative ($499/mês)
  - [ ] Listener pra pending transactions
  - [ ] Decoder de calldata: detectar swaps massivos
  - [ ] Calculator de impacto: prever HF crash em users afetados
  - [ ] Submitter prioritário: tx pra próximo bloco
  - Edge: capturar liquidações ANTES de aparecer no polling normal
  - Vantagem competitiva real

---

#### Unificação final (após Sprint 3)

- [x] Unificar detector liquidator pra rotear automaticamente entre Aave/Compound/Morpho/Seamless/Moonwell conforme HF — pipeline do
      liquidator roda os 4+ runners em paralelo.
- [x] Decidir prioridade quando mesma position é liquidável em múltiplos protocolos — resolvido via **EV gate pós-OEV** (prioriza Morpho).
- [x] Estatísticas: profit por protocolo/chain pra otimização dinâmica — ledger DuckDB + scoring OIE por dimensão (protocol/pool/token).

#### Trilha 2 — Radar Longtail/Medium-cap (CONCLUÍDA 2026-05-23 — sem edge)

- [x] Criar `apps/backtest/src/discover-pairs.ts` (descoberta automática pools UniV3+Aerodrome)
- [x] Discovery validou 5 pares viáveis (≥$50k TVL ambos DEXs): AERO/USDC, AERO/WETH, VIRTUAL/WETH, cbETH/WETH, wstETH/WETH
- [x] Excluídos LSTs (cbETH, wstETH) — documentados em `docs/NO_EDGE_TOKENS.md`
- [x] Reescrita `target-pairs.ts` com 3 pares estrelas (AERO/USDC, AERO/WETH, VIRTUAL/WETH)
- [x] Backtest 1000 blocos amostrados (~5,5h Base mainnet) com nova lista
- [x] **Resultado: 0 oportunidades cross-DEX detectadas**
- [x] **Conclusão: cross-DEX em Base 2026 não tem edge real, nem em blue chips nem em medium-cap. MEV bots cobrem TUDO em <100ms.**

**Decisão (2026-05-23):** Trilha 2 vira **radar passivo** — detector DRY_RUN continua escaneando os 3 pares, mas SEM expectativa de profit significativo. Energia principal foca em Trilha 1 (Liquidations).

#### Estado das estratégias de arbitragem cross-DEX em Base 2026 (aprendizado consolidado)

❌ **NÃO funcionam:**
- Cross-DEX em pares blue-chip (WETH/USDC, cbETH/WETH, USDC/USDT, USDC/DAI, WETH/AERO original)
- Cross-DEX em medium-cap com pools fragmentados (AERO/USDC, AERO/WETH, VIRTUAL/WETH)
- LSTs (cbETH/WETH, wstETH/WETH) — pegged, bots LST-arb dominam
- Memecoins (DEGEN, BRETT, TOSHI) — liquidez concentrada em UniV3 apenas, sem cross-DEX possível

✅ **Funcionam mecanicamente (validados em fork):**
- Wallet arb 2-step (UniV3 → Aerodrome) — engrenagem perfeita, edge inexistente
- Flashloan arb via Aave V3 — engrenagem perfeita, edge inexistente

✅ **Esperamos que funcionem (próximo):**
- Liquidações Aave V3 (Trilha 1) — janela 1-3 blocos, edge 5-10% por liquidação

#### Fase de integração (depois das 2 trilhas validadas isoladamente)

- [ ] Detector + Monitor rodando em paralelo, com kill switch independente por trilha
- [ ] Métricas separadas: oportunidades por trilha, profit por trilha, falhas por trilha
- [ ] Decisão: trilha primária = Liquidations, Longtail = adicional

---

### 🔮 Estratégias futuras (Fase 9+, paralelas à validação principal)

Mapeadas pelo Humberto em 2026-05-23 para implementação após Mix A+B estar em produção estável.

#### Estratégia C — Pools de RWA + LSTs

- [ ] Mapear tokens RWA na Base (agricultura sustentável, imobiliário, energia)
- [ ] Mapear LSTs (cbETH, wstETH se existir em Base)
- [ ] Monitor de discrepâncias de preço entre pools RWA/local vs stablecoins/LSTs
- Edge: bots institucionais ignoram (volume baixo + complexidade do ativo subjacente)
- Risco: liquidez muito baixa, slippage alto, due diligence do emissor

#### Estratégia D — Backrunning de baleias (dislocation pós-trade)

- [ ] Mempool listener Alchemy WSS pra pending txs
- [ ] Decoder de calldata pra identificar swaps grandes (>$100k) em DEXs alvo
- [ ] Calculadora de impacto pós-swap em cada pool
- [ ] Submitter prioritário pra entrar no bloco seguinte
- Edge: dislocation transitória (100ms-3s) após trade grande
- Vantagem Base: sem MEV-Boost/Flashbots agressivo como mainnet ETH → jogo é otimização de RPC
- Risco: requer latência baixa, possível concorrência crescendo

#### Estratégia E — Arbitragem ve(3,3) intra-Aerodrome

- [ ] Identificar pares Aerodrome com pools volatile (x*y=k) E stable (k = x³y + xy³) ativos
- [ ] Calcular discrepância entre as duas curvas pro mesmo par
- [ ] Arb intra-DEX (sem cross-DEX, sem competição cross-protocolo)
- Edge: tokens roteados ineficientemente entre pools volatile/stable do Aerodrome
- Vantagem: específico de Base, edge único, requer conhecimento da matemática ve(3,3)

### 🔴 Fase 5b — Testnet observação (2 semanas)

- [ ] Detector apontando pra Sepolia
- [ ] Owner chama `revive()` no contrato (sai do kill state)
- [ ] Owner chama `setOperator(bot_address, true)`
- [ ] Rodar 2 semanas observando comportamento real
- [ ] Coletar bugs / iterar parâmetros

**Critério pra próxima fase:**
- Bot rodou 2 semanas sem revert inesperado
- Kill switch testado e funcional
- Strategy escolhida em 4c mostrou oportunidades em testnet

### 🔴 Fase 6 — Liquidations completas (se opção A escolhida)

Detalhado em Fase 4c opção A acima.

### 🔴 Fase 7 — Deploy mainnet capital pequeno (1 mês de observação)

- [ ] Deploy `ZeusExecutor` em Base mainnet
- [ ] Multisig Safe Wallet como owner
- [ ] Capital inicial: **0.5 ETH** (~$1.5k)
- [ ] `MAX_TRADE_ETH=0.1` (cap baixo pra observação)
- [ ] Tenderly alerts + Discord webhook ativos
- [ ] Rodar 2-4 semanas observando
- [ ] Análise semanal: PnL, drawdown, padrões

**Critério pra escalar:**
- 4 semanas sem perda significativa
- PnL líquido positivo
- Sem incidentes operacionais

---

### 🔴 Fase 6 — Liquidations (1 semana) ✅ CONCLUÍDO (checkboxes = registro; feito em `apps/monitor` + `apps/liquidator` + `ZeusLiquidator.sol`, nomes diferentes do planejado)

- [ ] `monitor/protocols/aaveV3.ts` — leitura de positions, cálculo HF
- [ ] `monitor/protocols/compoundV3.ts`
- [ ] `monitor/protocols/morpho.ts`
- [ ] `monitor/healthFactor.ts` — engine de cálculo
- [ ] `monitor/liquidator.ts` — dispara `liquidatePosition` no ZeusExecutor
- [ ] `strategies/LiquidatorStrategy.sol`
- [ ] Tests com fork
- [ ] Testnet 1 semana

---

### 🔴 Fase 7 — Deploy mainnet capital pequeno (1 mês de observação)

- [ ] Deploy `ZeusExecutor` em Base mainnet
- [ ] Multisig Safe Wallet como owner
- [ ] Capital inicial: **0.5 ETH** (~$1.5k)
- [ ] `MAX_TRADE_ETH=0.1` (cap baixo pra observação)
- [ ] Tenderly alerts configurados
- [ ] Discord webhook ativo
- [ ] Rodar 2-4 semanas observando
- [ ] Análise semanal: PnL, drawdown, padrões

**Critério pra escalar:**
- 4 semanas sem perda significativa
- PnL líquido positivo
- Sem incidentes operacionais

---

### 🔴 Fase 8 — Audit externo (1-2 semanas)

- [ ] Selecionar audit provider (Certik / Trail of Bits / OpenZeppelin Defender / Halborn)
- [ ] Preparar repo pra audit (código limpo, NatSpec completo, testes 95%+ coverage)
- [ ] Submit code freeze
- [ ] Receber relatório
- [ ] Corrigir findings (high/critical mandatórios, medium recomendados)
- [ ] Re-audit dos fixes
- [ ] Publicação do relatório

**Custo estimado:** US$ 4.200 (Certik — alinhado com Etapa 2 do pacote Enterprise Nortoken) a US$ 25k+ (Trail of Bits).

---

### 🔴 Fase 9 — Scale (indefinido)

- [ ] Capital aumentado escalonadamente (post-audit)
- [ ] Multi-chain: Arbitrum One
- [ ] Multi-chain: Optimism
- [ ] Bug bounty Immunefi (US$ 5-10k pool)
- [ ] Dashboard de monitoramento (Grafana?)
- [ ] Otimizações de gas baseadas em produção
- [ ] Considerar self-hosted Reth pra latência

---

## 🟡 Melhorias técnicas (paralelo / pós-Fase 7)

### Performance
- [ ] Otimização extrema de calldata size (impacta gas)
- [ ] Considerar MultiCall pra reads em batch
- [ ] Pre-aprovação de tokens pra adapters

### Qualidade
- [ ] Coverage 95%+ em contratos
- [ ] Coverage 80%+ em TS
- [ ] Property-based tests com Echidna (alternativa ao Foundry fuzz)
- [ ] Static analysis: Slither + Mythril em CI

### CI/CD
- [ ] GitHub Actions:
  - [ ] Lint + typecheck em PR
  - [ ] `forge test` em PR
  - [ ] Slither em PR
  - [ ] Deploy testnet automático em main
- [ ] Pre-commit hooks (`forge fmt`, lint)

### Observabilidade
- [ ] Tenderly alerts customizados
- [ ] Forta Network (free) detect agents
- [ ] OpenZeppelin Defender Sentinel
- [ ] Métricas exportadas pra Grafana

### Documentação
- [ ] Runbook de incident response
- [ ] Audit findings publicados
- [ ] API docs auto-geradas (typedoc)
- [ ] Bug bounty config Immunefi

---

## 🟢 Pequenos itens / polimento

- [ ] Favicon e meta tags se algum dia tiver dashboard
- [ ] Adicionar badges no README (build status, coverage, last deploy)
- [ ] CHANGELOG.md
- [ ] CONTRIBUTING.md (mesmo sendo projeto privado, padrão é bom)

---

## 🔄 Em andamento

- [x] ~~Trilha 1 part 1 (Liquidações Aave V3 Base)~~ — entregue 2026-05-23
- [x] ~~Trilha 2 (Radar Longtail)~~ — concluída 2026-05-23, sem edge, vira radar passivo
- [x] ~~Sprint 1 REVISADO (Aave V3 Arbitrum + Optimism)~~ — entregue 2026-05-26 (361 borrowers cobertos, 11 em risco)
- [x] ~~Sprint 2 (LRT depeg arb)~~ — cancelado (sem edge); substituído pelo radar MIS (Motor 2 / `apps/mis-scanner`)
- [x] ~~Sprint 3 (Compound III + Morpho + Moonwell)~~ — entregue (pipelines TS dos 3 protocolos + contratos v8 split). Achado OEV → foco em Morpho.
- [x] ~~Camada OIE (Etapa A+B + ledger DRY_RUN + Fly configs)~~ — entregue 2026-06-15 (ver seção dedicada no topo)
- [ ] **Próximo:** DRY_RUN observação mainnet (read-only) — detector + MIS gravando no ledger → decidir arb-engine

---

## ⏸️ Pausado / aguardando decisão do Humberto

- [x] ~~Decidir quando fazer push pro GitHub~~ → push contínuo desde Fase 1
- [x] ~~Provider de RPC primário~~ → **dRPC** (210M CU/mês free) + Alchemy fallback
- [x] ~~Estratégia de edge~~ → **Mix A+B em duas trilhas independentes** (decidido 2026-05-23)
- [ ] **Ordem de execução das trilhas**: Trilha 1 primeiro / Trilha 2 primeiro / paralelo
- [ ] Lista concreta de tokens RWA + LSTs em Base (pesquisa pra Trilha 2)
- [ ] Definir multisig provider (Safe Wallet vs alternativa) — antes de Fase 7
- [ ] Definir capital inicial concreto pra Fase 7
- [ ] Decidir se Neon Postgres entra ou só logs por enquanto
- [ ] Definir audit provider (Certik vs Trail of Bits vs OpenZeppelin) — antes de Fase 8

---

## 🐛 Bugs conhecidos / riscos abertos

- [ ] Sem audit externo ainda — capital alto = risco alto (audit interno Pass 1+2 feito; Trail of Bits/Spearbit fica pra capital > $50k)
- [x] ~~Sem testes com fork mainnet~~ — agora há fork tests via Alchemy (arb + liquidações + prova de lucro dos 3 motores em `MotorsProfit.fork.t.sol`)
- [ ] Sem MEV protection — outras bots podem nos sandwich (mitigado parcialmente pelo BribeManager + flashloan atômico)
- [ ] Single private key — futuro: MPC ou hardware wallet

---

## 📈 Métricas de sucesso (planejado)

Quando estiver em produção, monitorar:

- **Success rate de tx** (norte: > 70%)
- **Avg landed time** (norte: < 2 blocos = < 4s)
- **Profit per trade** (norte: > $5 líquido após gas+fee)
- **Oportunidades capturáveis/dia** (norte: > 10)
- **Drawdown máximo** (limite hard: 25%)
- **Capital efficiency** (profit/capital deployed)

---

## 📝 Histórico de mudanças

| Data | Mudança principal |
|---|---|
| 2026-05-22 | Setup inicial (Fase 0): monorepo pnpm + Foundry + 7 docs canônicos |
| 2026-05-22 | Fase 1: ZeusExecutor + UniV3Lib + AerodromeLib + 22 testes passando |
| 2026-05-22 | Fase 2: Detector DRY_RUN — dex-adapters + opportunities + WSS subscribe |
| 2026-05-22 | Fase 3: Flashloan Aave V3 + TxBuilder + Simulator + integração detector |
| 2026-05-22 | Track A: Deploy ZeusExecutor em Base Sepolia (`0xe48473...`) + verified Basescan |
| 2026-05-22 | Track B: Refactor `packages/strategy` + `apps/backtest` + fork tests profitArb (29/29) |
| 2026-05-23 | Decisão Fase 4c: **Mix A+B em duas trilhas** (Liquidações + Longtail) + adicionadas 3 estratégias futuras (RWA/LST, Backrunning baleias, Aerodrome ve(3,3)) |
| 2026-05-23 | Trilha 2 concluída: discover-pairs + 3 pares longtail (AERO/USDC, AERO/WETH, VIRTUAL/WETH) + `docs/NO_EDGE_TOKENS.md`. **Backtest: 0/1000 oportunidades — cross-DEX em Base 2026 é dead-end confirmado**. Trilha 2 vira radar passivo, foco vai pra Trilha 1 (Liquidations). |
| 2026-05-23 | Trilha 1 iniciada. Decisões: Aave V3 only (Compound III + Morpho como Fase 6.5), Subgraph pra descoberta de positions, 100% flashloan. Criado `docs/INFRA_EVOLUTION.md` mapeando 5 estágios de infra (Estágio 0 hoje → Estágio 4 longo prazo). |
| 2026-05-23 | **Trilha 1 part 1 ENTREGUE**: executeLiquidation() + apps/monitor completo + 4 fork tests Aave V3 PASSANDO. Total testes: 33/33. ZeusExecutor v2 redeployado em Sepolia: `0xe53cb8ced877eac30ce39bf1b3c592602ba3c428` (verified). Teste principal: position artificial 10 WETH + $12k debt → crash 40% WETH → liquidação capturou $8.643 profit em 1 tx. |
| 2026-05-23 | **Multicall3 implementado** no healthFactor.ts — HF check de 20s → 3s (6.7x mais rápido). Validado contra Base mainnet: 123 borrowers ativos reais detectados (resto são "fantasmas" do subgraph). |
| 2026-05-23 | **Plano de Expansão decidido** (Fase 6.5 detalhada em 4 sprints): Sprint 1 (Seamless + reduzir MIN_DEBT) → Sprint 2 (Arbitrum + Optimism) → Sprint 3 (Compound III + Morpho + Moonwell) → Sprint 4 (Mempool watching). Objetivo: passar de 123 → 7.000+ borrowers monitorados em ~4 semanas. Próxima sessão: começa Sprint 1 segunda 2026-05-25. |
| 2026-05-26 | **Princípio operacional definido**: FLASHLOAN-ONLY até primeiro lucro; quando bot gerar receita real, 45% reinvestido em capital próprio pra outras estratégias do ecossistema ZEUS. Aprovadas: Liquidations, JIT Liquidity, LRT depeg arb, Vault liquidations. Rejeitadas: IR arb, HF rebalancing as service, sandwich. |
| 2026-05-26 | **Sprint 1 PIVOT**: Seamless migrou pra Morpho em 2025 (não faz mais sentido fork Aave standalone). Substituído por Sprint 1 REVISADO = **Aave V3 multi-chain (Arbitrum + Optimism)**. Reusa 95% do código, 40x mais borrowers. |
| 2026-05-26 | **Sprint 1 ENTREGUE**: ZeusExecutor v1 deployado e verified em Arbitrum Sepolia + Optimism Sepolia (mesmo endereço `0xd7e8fde4451d5352e7644d4a601a243528765df3` em ambas via CREATE2 deterministic). Monitor refatorado multi-chain (CHAIN_ID env var). Validação DRY_RUN: **Arbitrum=293 borrowers c/ debt + 10 em risco**, **Optimism=63 borrowers + 1 em risco**. **72x mais positions monitoradas que Base sozinho.** |
| 2026-05-26 | **Sprint 2 CANCELADO**: tentamos LRT cross-DEX (cbETH+wstETH), descobrimos que mid-price spread NÃO é capturável (slippage destrói em pools rasos). Lição documentada em NO_EDGE_TOKENS.md. Pivot pra Sprint 3 (multi-protocolo) que tem edge confirmado. |
| 2026-05-26 | **Sprint 3A ENTREGUE**: Compound III. Interface IComet.sol + struct CompoundLiquidationParams + executeCompoundLiquidation() + dispatch. Fork tests 4/4 PASS (revert paths + sanity). Monitor protocols/compoundV3.ts via eventos Withdraw + Multicall3 isLiquidatable. Cobertura Base+Arb+OP (cUSDCv3 + cWETHv3). Total: 37/37 testes. |
| 2026-05-26 | **Sprint 3B ENTREGUE**: Morpho Blue. Interface IMorpho.sol + struct MorphoLiquidationParams + executeMorphoLiquidation() + dispatch. Fork tests 5/5 PASS. Monitor protocols/morpho.ts via subgraph oficial Base (schema-fix pendente — campos diferentes do assumido). Cobertura Base only (Morpho ativo apenas em Base mainnet em 2026). Total: **42/42 testes Foundry** + 6/6 typecheck workspaces.
| 2026-05-25 | **Sprint 3 FECHAMENTO**: (1) Fix schema Morpho subgraph — Position/Market refletem Messari-format (`account.id`, `market.inputToken`=collateralToken, `position.asset`=loanToken, `liquidationThreshold` BigDecimal→WAD); campo `irm` não existe no subgraph, marcado com flag `irmResolved:false` pra enrichment on-chain antes de dispatch real. (2) **Redeploy ZeusExecutor v6** (Aave + Compound + Morpho) nas 3 chains testnet, todas verified: Base Sepolia `0xe38298B4d242d0D1C45696a96c4C588926Cf1139`, Arbitrum Sepolia `0xe48473D75805886Ac4162B1304EAB6b8F93C5faa`, Optimism Sepolia `0xe48473D75805886Ac4162B1304EAB6b8F93C5faa`. (3) `.env` atualizado. foundry.toml ganhou aliases `arbitrum_sepolia`+`optimism_sepolia` (Etherscan v2 unified key). 42/42 Foundry + 6/6 typecheck preservados.
| 2026-05-25 | **Contratos v6 armed em testnet**: 3× revive() + 3× setOperator(0xE060…cBB4) executados via `cast send`. Estado on-chain validado em todas: isKilled=false, isOperator=true. Prontos pra observação contínua DRY_RUN.
| 2026-05-25 | **Live validation DRY_RUN nas 4 chains**: monitor boot OK em Base Sepolia (executor v6 lido do .env), Arb Sepolia, OP Sepolia, e Base mainnet. Aave V3 funcional nas 4. **Morpho schema-fix validado live em Base mainnet — 200 positions ativas retornadas com loanToken/collateralToken/oracle/lltv corretos (USR/BONDUSD, USDtb/sUSDe, RLUSD/syrupUSDC)**. Testnet vazia em Arb/OP (esperado).
| 2026-05-25 | **Fix Compound chunking**: `fetchCompoundActiveBorrowers` ganhou chunking interno em janelas de 9_999 blocos (compatível com free tier dRPC/Alchemy). Lookback do caller reduzido de 100k → 10k pra caber em 1 call sem timeout (steady-state polling 60s captura novos eventos via delta). Validado live em Base mainnet: cUSDCv3=7 borrowers · cWETHv3=32 borrowers · 0 liquidáveis. Pendência menor: rate limit transitório no 1º tick de boot quando dRPC já está sobrecarregado — absorvido pelo try/catch do loop, próxima iteração recupera. Pra cobertura histórica >10k blocos sem free tier limits, precisa refactor bootstrap+steady-state OU provider pago.
| 2026-05-25 | **Security Audit Pass 1 + Pass 2 + 4 fixes aplicados**: (Pass 1) revisão TS off-chain mudanças do dia — 0 Critical/High, 4 MEDIUM documentadas. (Pass 2) audit profundo `ZeusExecutor.sol` (915 LOC) sob lente Jim Manico AppSec + Omar Santos vuln assessment: identificados **2 HIGH + 4 MEDIUM**. **4 fixes aplicados**: (H-01) approval Morpho de `type(uint256).max` → bounded `amount` + reset post-call em `_handleMorphoLiquidationOperation`; (H-02) `mapping(token => maxTradeWei)` per-token + `setMaxTradePerToken` + `getMaxTradeFor` aplicados em todos os entrypoints + `_executeSwaps` — resolve mistura de decimals (USDC/USDT/WBTC vs WETH); (M-01) snapshot `balanceBefore` pre-flashloan capturado nos 3 entrypoints de liquidação + encoded em params + descontado no profit calc dos handlers — pre-existing balance protegido contra drain via operator malicioso; (M-02) novo campo explícito `MorphoLiquidationParams.flashloanAmount` substitui mistura `seizedAssets`/`repaidShares` como flashloan amount. **Tests**: 42/42 anteriores preservados + 11 novos adversariais = **53/53 PASS**. 7/7 typecheck workspaces TS. Audit substitui parcialmente Certik ($4.2k poupados, redirecionados pra infra: Alchemy Growth + Fly.io 24/7 + Tenderly Pro + Ledger).
| 2026-05-25 | **Liquidator Sprint 1 — Aave V3 scaffold + pipeline completo**: Novo workspace `apps/liquidator` separado do monitor. Componentes: (1) `config.ts` com 3 modos `LIQUIDATOR_MODE=dryrun\|testnet\|mainnet` (default dryrun), close factor Aave configurável, slippage tolerance, gas estimate; (2) `chainContext.ts` resolve client + wallet opcional por chain; (3) `protocols/aave/calculator.ts` algoritmo binary search: 10 samples logarítmicos + 5 de refinamento local sobre `flashloanAmount`, valida via UniswapV3 QuoterV2 nos 4 fee tiers, escolhe melhor profit líquido (após repay + 0.05% flashloan fee + gas estimate); (4) `protocols/aave/simulator.ts` wrapper sobre simulator genérico do strategy package; (5) `protocols/aave/builder.ts` calldata de `executeLiquidation` com swapSteps single-swap UniV3; (6) `dispatcher.ts` com 3 gates (simulação OK → modo dryrun? → wallet presente?) + `waitForTransactionReceipt` em testnet/mainnet; (7) `pipeline.ts` orchestrator calc→build→sim→dispatch; (8) `index.ts` boot + cache `getMaxTradeFor` por debt asset comum + API programática `processOpportunity()` + standalone demo opcional. **ABI atualizada** com `flashloanAmount` Morpho + `setMaxTradePerToken` + `getMaxTradeFor` views. **Smoke boot validado** em DRY_RUN contra Base mainnet (gates funcionando como esperado, abortou em "no executor deployed" — correto). **8/8 typecheck workspaces**. Pendência consciente pra próxima sessão: discovery automático Aave (resolver collateralAsset/debtAsset/bonus via getUserConfiguration + getReserveData on-chain) — hoje requer position passada externamente via `processOpportunity()`.
| 2026-05-25 | **Liquidator discovery automática Aave V3 ENTREGUE (pendência #1)**: 3 novos arquivos: (1) `protocols/aave/abi.ts` ABIs Pool + PoolAddressesProvider + PoolDataProvider + ERC20View; (2) `protocols/aave/reserves.ts` cache de reserves+config Aave V3, resolve `poolDataProvider` dinamicamente via `PoolAddressesProvider.getPoolDataProvider()` — robusto a rotações Aave; (3) `protocols/aave/discovery.ts` pipeline subgraph→Multicall3→par dominante: `fetchAaveV3Candidates` lista users com debt, `fetchHealthFactorsBatch` filtra HF<threshold via Multicall3 batch=100, `resolveBorrowerPositionPair` escolhe top-1 collateral (maior aTokenBalance + usageAsCollateral) e top-1 debt (maior variable+stable debt), `discoverAaveLiquidatablePositions` orquestra tudo. `index.ts` ganhou `discoveryTick()` + setInterval polling 60s. **Live validation Base mainnet (block 46471104)**: 200 candidatos subgraph → **28 at-risk** (HF < 1.05) → **2 positions com par (collateral,debt) resolvido** → pipeline rejeitou os 2 (correto: sem executor deployado em Base mainnet). PoolDataProvider resolvido dinamicamente: `0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A`. 15 reserves ativos cacheados em 1 RPC roundtrip via Multicall3. **8/8 typecheck preservado**. Liquidator agora roda 24/7 autônomo em DRY_RUN, gerando dados pra calibração.
| 2026-05-25 | **Liquidator event decoder ENTREGUE (pendência #2)**: Novo arquivo `apps/liquidator/src/eventDecoder.ts` com `decodeLiquidationEvent(receipt, executorAddr)` que itera logs do receipt, filtra pelo address do executor (ignora logs de Aave/Compound/Morpho), tenta decodar pelos 4 eventos canônicos (`LiquidationExecuted`, `CompoundLiquidationExecuted`, `MorphoLiquidationExecuted`, `FlashloanArbitrageExecuted`, `ArbitrageExecuted`) — primeiro match vence. Helper `profitDeltaBps(real, expected)` retorna delta em bps (positivo = MEV favorável, negativo = slippage > estimado). **DispatchOutcome.confirmed expandido**: agora inclui `profitWei` (real do event), `expectedProfitWei`, `profitDeltaBps`, `gasUsed`, `blockNumber`, `eventName`. **Dispatcher**: após `waitForTransactionReceipt` status=success, chama decoder, calcula delta, e LOGA banda de calibração: dentro de ±1% = 🎯 calibrado; +1% acima = 🟢 favorável (underestimate ou MEV+); -1% abaixo = 🟠 slippage > estimado (sinal pra ajustar `MAX_SLIPPAGE_BPS`). **Pipeline**: passa `decision.expectedProfitWei` pro dispatcher. **8/8 typecheck verde**. Decoder não exercitado em smoke test (sem tx confirmed ainda — requer executor deployado em mainnet OR dispatch real em testnet); validação real virá com primeira liquidação confirmada.
| 2026-05-25 | **Log humanizado de profit + USD ENTREGUE**: Novo `apps/liquidator/src/priceUtils.ts` com (1) `formatWei(wei, decimals)` → string decimal humano "12.45", (2) `estimateUsd(symbol, wei, decimals, ethPrice)` reconhecendo stables (peg $1) + ETH-family (× ETH price) + BTC-family (× ETH × 21), (3) `gasCostUsd(gasUsed, gasPrice, ethPrice)` via `receipt.effectiveGasPrice`. **Config**: novo `ETH_USD_PRICE_ESTIMATE` default $3000 (hardcoded MVP, TODO: substituir por Chainlink ETH/USD oracle on-chain). **Dispatcher**: log de tx confirmada agora inclui linha humana `💰 profit=$12.45 (gas $0.32, líquido $12.13)` + banda de calibração + campos JSON estruturados (`realProfitFormatted`, `realProfitUsd`, `gasCostUsd`, `netProfitUsd`). **DispatchOutcome.confirmed** ganhou 5 fields USD. **Pipeline**: propaga `position.debtAssetDecimals`/`debtAssetSymbol` + `env.ETH_USD_PRICE_ESTIMATE` pro dispatcher. Reconhecimento automático de tokens via 3 Sets (`STABLE_SYMBOLS`, `ETH_SYMBOLS`, `BTC_SYMBOLS`).
| 2026-05-25 | **Shared discovery package ENTREGUE (pendência #3)**: Novo workspace `packages/aave-discovery/` com 5 arquivos: (1) `abi.ts` ABIs Aave V3 Pool/PoolAddressesProvider/PoolDataProvider/ERC20View + `POOL_ADDRESSES_PROVIDER_BY_CHAIN` map; (2) `logger.ts` interface `LoggerLike` (pino-compatible) + `NOOP_LOGGER` pra default silencioso; (3) `types.ts` `AaveCandidate` + `AaveLiquidatablePosition`; (4) `reserves.ts` `buildAaveReservesCache` com logger injetável; (5) `discovery.ts` pipeline completo (`fetchAaveV3Candidates`, `fetchHealthFactorsBatch`, `resolveBorrowerPositionPair`, `discoverAaveLiquidatablePositions`). **Liquidator migrado**: removidos 3 arquivos locais (`protocols/aave/{abi,reserves,discovery}.ts`), adicionado `@zeus-evm/aave-discovery` como workspace dep, `types.ts` re-exporta `AaveLiquidatablePosition` do package. **9/9 typecheck workspaces** + smoke boot Base mainnet OK (29 at-risk → 1 com par resolvido). Monitor NÃO migrado nessa sessão (não-bloqueante; migração futura economiza ~50% das RPC calls duplicadas entre os 2 apps). Package está pronto pra ser consumido por qualquer app que precise discovery Aave V3.
| 2026-05-25 | **Slippage cache + bug fix calculator ENTREGUE (pendência #6)**: Novo `apps/liquidator/src/slippageCache.ts` com classe `SlippageCache` (TTL 60s default, lookup por chave exata `${tokenIn}|${tokenOut}|${fee}|${amountIn}` lowercased) + helper `cachedQuoteUniswapV3` (wrapper transparente sobre `quoteUniswapV3` que faz lookup→fetch→cache automaticamente; só cacheia Quote bem-sucedida, erros sempre re-tentam). Singleton compartilhado entre Aave + Compound calculators. Métricas expostas via `stats()` (hits/misses/size/hitRate). `pruneExpired()` chamado a cada tick. **Integração**: substituído `quoteUniswapV3` por `cachedQuoteUniswapV3` em [aave/calculator.ts](apps/liquidator/src/protocols/aave/calculator.ts) + [compound/calculator.ts](apps/liquidator/src/protocols/compound/calculator.ts). `discoveryTick` no index.ts agora loga `cache=hits/total (hitRate%)` por tick. **Refactor pipeline**: gate "no executor" movido pra DEPOIS do calculator, retornando `dryrun_skipped` em vez de `reverted_pre_dispatch` — calculator agora roda SEMPRE em DRY_RUN mainnet, alimenta cache e LOGA decision teórica via `🔭 [no-executor]` event pra calibração das 2 semanas de observação. **Bug NaN corrigido**: `BigInt(Math.floor(env.MIN_DEBT_USD))` virava `0n` quando MIN_DEBT_USD < 1, causando `Math.pow(Infinity, ...)→NaN→BigInt(NaN) throws` no sample logarítmico. Fix: clamp `Math.max(1, Math.floor(...))` em ambos calculators. **Live validation**: cache foi exercitado (4 misses em 1 position = 1 × 4 fee tiers UniV3 correto), confirmando pipeline funcional. Hit rate 0% em testes atuais porque positions detectadas em Base mainnet são dust ($0.00001-0.03 de debt) — sem volume real de liquidations grandes no momento (Aave Base 2026 tem ~123 borrowers, maioria saudável). Cache vai mostrar valor real quando houver positions ≥ $100. **⚠️ Warning visível adicionado no config.ts** + nova seção "PRÉ-ATIVAÇÃO MAINNET — CHECKLIST OBRIGATÓRIO" no topo do TODO.md (anotação Humberto: lembrar de restaurar thresholds de prod antes de jogar pra main). **9/9 typecheck preservado.**
| 2026-05-25 | **Sprint 2 — Compound III pipeline ENTREGUE (pendência #4)**: Novo módulo `apps/liquidator/src/protocols/compound/` com 5 arquivos: (1) `abi.ts` Comet ABI (`isLiquidatable`, `baseToken`, `numAssets`, `getAssetInfo`, `quoteCollateral`, `collateralBalanceOf`) + `Withdraw` event; (2) `comets.ts` cache de Comet info — `buildCompoundCometCache` itera todos os Comets configurados, faz Multicall3 batch pra cada (baseToken + symbol/decimals + iterar getAssetInfo até numAssets); (3) `discovery.ts` `fetchCompoundActiveBorrowers` (event scan chunked 9999 blocos pra free tier), `findLiquidatableBorrowers` (Multicall3 isLiquidatable batch=100), `resolveTopCollateralForBorrower` (Multicall3 collateralBalanceOf → top-1 por wei), `discoverCompoundLiquidatablePositions(ForComet)` orquestradores; (4) `calculator.ts` `calculateOptimalCompoundLiquidation` binary search com `Comet.quoteCollateral` on-chain (já dá desconto aplicado — math mais simples que Aave) + swap sim UniV3 + filtro `MAX_SLIPPAGE_BPS`; (5) `builder.ts` calldata `executeCompoundLiquidation` com `minCollateralReceived` slippage on-chain + swapSteps single-swap. **types.ts**: novo `CompoundLiquidatablePosition`. **pipeline.ts**: `runCompoundPipeline` com mesma estrutura do `runAavePipeline` (3 gates + dispatcher). **index.ts**: boot constrói `compoundCometCache` em paralelo ao `aaveReservesCache` (Comets cUSDCv3 + cWETHv3 lidos do `chainConfig.compoundV3`), `discoveryTick` agora roda Aave + Compound sequencialmente com stats unificadas. **Live validation Base mainnet**: cache 5 collaterals cUSDCv3 + 8 collaterals cWETHv3 buildado, tick 3 mostrou Compound discovery rodando (cUSDCv3: 6 borrowers ativos via event scan, 0 liquidatable atualmente; cWETHv3: 0 borrowers na janela 5h). Ticks 1-2 falharam por rate limit transitório dRPC (problema conhecido, recuperado em tick 3). **9/9 typecheck workspaces preservado**. Cobertura agora: **3 protocolos sob radar** (Aave V3 + Compound III + Morpho via monitor antigo). |
| 2026-06-15 | **Sprint 3 completo + contratos v8 SPLIT (EIP-170)**: monolito `ZeusExecutor` v6 estourava o limite de 24KB de bytecode → quebrado em 4 contratos: `ZeusArbExecutor.sol` (arb + flashloan arb), `ZeusLiquidator.sol` (Aave/Compound/Morpho/Seamless), `ZeusMoonwellLiquidator.sol` (Moonwell dedicado) e `BribeManager.sol`. Pipelines TS dos 3 protocolos do Sprint 3 (Compound III + Morpho Blue + Moonwell) entregues, com IRM enrichment on-chain pro Morpho. **Flashloan multi-fonte 0%**: Morpho + Balancer primário (`IBalancerVault`/`IMorpho`), Aave 0.05% como fallback. Testes: **115 funções Foundry (9 arquivos) + 43 TS**. Gaps de produção fechados além dos 7 críticos: pause detection (`pauseDetector`/`autoPauseManager`), oracle staleness (`chainlinkStaleness`), block staleness (`blockStalenessCheck`), multi-collateral evaluation (`MULTI_COLLATERAL_EVAL_ENABLED`), health endpoint (`/healthz`+`/readyz` via `startHealthServer`). |
| 2026-06-15 | **Camada OIE + DRY_RUN intelligence ENTREGUE**: Etapa A (scoring Opportunity/Protocol/Pool/Token em `execution-utils/src/scoring/` + ledger DuckDB com fix de timestamp BIGINT) + Etapa B (EV gate competitor-aware via gas war no backrun-engine + EV gate ciente de OEV no liquidator → prioriza Morpho). Detector + MIS scanner gravam observações no ledger (`arb_observed`/`mis_observed`); helpers de ranking de pares (`queryTopOpportunityPairs`/`attachAndRankPairs`); detector consome auto-targets do discovery-scraper na varredura dinâmica. Deploy Fly.io: `Dockerfile` + `deploy/fly/*.toml` com volume persistente. **Achado OEV (reorienta estratégia)**: liquidação na Base se fecha por OEV (Aave SVR ~85%, Compound ~85%, Moonwell MEV tax ~99%); **Morpho Blue (0% recapture) = único edge real**. `OEV_RECAPTURE_PRIORS` calibráveis. Gate opt-in `MIN_OPPORTUNITY_EV_USD`. **13/13 typecheck** + execution-utils 288/289 (única falha pré-existente). Detalhes: [`docs/OIE_PROGRESS.md`](./docs/OIE_PROGRESS.md). |
| 2026-06-15 | **Status real**: contratos ainda em **Sepolia** (NÃO mainnet). **Lucro real US$ 0**. Próximo passo: DRY_RUN observação mainnet read-only (detector + MIS gravando no ledger) → decidir arb-engine. Etapas C (thresholds adaptativos) e D (8 dashboards Grafana) pendentes. |

---

## 📚 Documentação de referência (nova — OIE + estratégia)

Docs criados/atualizados na camada OIE e pesquisa de mercado. Consultar ANTES de calibrar gates ou decidir deploy:

| Doc | Conteúdo |
|---|---|
| [`docs/OIE_PROGRESS.md`](./docs/OIE_PROGRESS.md) | Status de adoção do OIE (Etapas A→D), decisão Morpho, como ligar os gates |
| [`docs/refs/competitive-landscape.md`](./docs/refs/competitive-landscape.md) | Mapa competitivo + OEV recapture por protocolo (achado central) |
| [`docs/refs/infra-costs.md`](./docs/refs/infra-costs.md) | Custos de infra (RPC, mempool, Fly.io) |
| [`docs/refs/morpho-profit-projection.md`](./docs/refs/morpho-profit-projection.md) | Projeção de lucro do edge Morpho |
| [`docs/refs/engine-strategy.md`](./docs/refs/engine-strategy.md) | Estratégia dos motores (foco Morpho + decisão arb-engine) |
| [`docs/refs/cross-dex-arb-status.md`](./docs/refs/cross-dex-arb-status.md) | Status do cross-DEX arb (dead-end confirmado em blue chips) |
| [`docs/refs/fly-deploy.md`](./docs/refs/fly-deploy.md) | Guia de deploy Fly.io (volume persistente pro ledger DuckDB) |
