# PROJECT_CONTEXT — ZEUS EVM

Visão consolidada do projeto. Atualizado a cada fase aprovada.

---

## 🎯 O que é

**ZEUS EVM** é um bot de MEV on-chain em EVM, **flashloan-first** (Aave V3), com **3 motores descorrelacionados** coexistindo no mesmo codebase: **Liquidations** (Motor 1), **Cross-DEX Arb** (Motor 2 — MIS scanner virou motor de execução cross-DEX/triangular, **execução OFF por default**) e **Backrun** (Motor 3).

**Chain inicial:** Base (Coinbase L2). Por quê?
- Gas barato (~$0.01/tx) viabiliza testes massivos
- Menos competição MEV que mainnet
- Aave V3 ativo (pra flashloan + liquidations)
- Aerodrome (DEX dominante) + Uniswap V3 + BaseSwap = pool diversificado

**Next chains** (após validar Base): Arbitrum One → Optimism → BSC.

---

## 🧱 Stack

| Camada | Tech | Por quê |
|---|---|---|
| Off-chain | TypeScript + Node 22 + viem | Type safety + fluência |
| Contracts | Solidity 0.8.27 + Foundry | via_ir + fuzzing rápido |
| Provider | Alchemy primário + público fallback | Alchemy tem mempool subscription |
| Flashloan | Aave V3 (0.05% fee) | Universal e flexível |
| Deploy | Fly.io | Padrão MAZARI |
| Monorepo | pnpm workspaces | Padrão MAZARI |

---

## 🏗️ Arquitetura em alto nível

```
┌──────────────────────────────────────────────────────────────┐
│                   ZEUS EVM monorepo                           │
└──────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐  ┌─────────────────┐  ┌────────────────┐
│ apps/detector │  │   contracts/    │  │ apps/monitor   │
│  (off-chain)  │  │   (Solidity)    │  │ (liquidations) │
│               │  │                 │  │                │
│ Mempool       │  │ ZeusExecutor    │  │ HealthFactor   │
│ Price oracles │──│ + adapters DEX  │──│ poller         │
│ Opportunity   │  │ + flashloan     │  │ Trigger        │
│ calculator    │  │ + liquidator    │  │ liquidation    │
│ Tx submitter  │  │                 │  │                │
└───────────────┘  └─────────────────┘  └────────────────┘
        │                   │                   │
        └─────────── shared ┴───────────────────┘
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
┌──────────────────┐  ┌────────────────────┐
│ packages/        │  │  scripts/          │
│ chain-config     │  │  deploy.ts         │
│ dex-adapters     │  │  simulate.ts       │
│ shared-types     │  │  (Foundry scripts) │
└──────────────────┘  └────────────────────┘
```

Detalhamento em [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 🤖 Instruções para IA (vibe coding)

- Sempre respeitar princípios de risco do [CONTEXT.md](./CONTEXT.md)
- `pnpm typecheck && pnpm contracts:test` deve passar antes de "concluído"
- Nunca commitar `.env` — só `.env.example`
- Audit interno antes de mainnet, audit externo antes de capital alto
- Sempre Foundry fork test antes de assumir que vai funcionar
- Adapters DEX devem ser modulares (1 arquivo por DEX)
- Atualizar este arquivo após cada fase aprovada

---

## 📊 Status atual (snapshot 2026-06-15)

### 🆕 Sessão 2026-06-23 (resumo — detalhes em `CLAUDE.md`)
- **Motor 2 — expansão de DEX + toggle remoto MERGEADOS na `main`** (Slipstream + forks UniV3/UniV2 + adapter `PancakeV3Lib`/`DexType.PancakeV3`; Sushi V3 na Base também usa deadline). DexType unificado (fonte única + pin test).
- **Endereços verificados on-chain** (Alchemy archive); dackie/rocket removidos. **RPC = Alchemy primário**.
- **CI** com job `contracts-fork` (trap de endereços) + fix `forge install`. **Redeploy testnet v8** (revive + setOperator nos 2 executors).
- **Cola do painel:** Supabase criado/verificado + `genericWebhookSink` com `x-zeus-secret` + `zeus.heartbeat` no Motor 2.
- **Falta:** 4 envs na Vercel + redeploy · `GENERIC_WEBHOOK_URL` (URL do painel) · secret `BASE_RPC_ARCHIVE` no GitHub · Moonwell revive/setOperator · Fly.io + 2 semanas DRY_RUN.

### ✅ Concluído

**Camada on-chain (4 contratos v8 split — resolve EIP-170):**
- **BribeManager** (gorjeta MEV) + **ZeusLiquidator** (Aave/Compound/Morpho) + **ZeusArbExecutor** (arb/backrun) + **ZeusMoonwellLiquidator** (Moonwell)
- Audit interno Pass 1-4 + fixes B-1 a B-7. Deployados em **Sepolia (testnet), NÃO mainnet**.
- **Flashloan 3 fontes** no ZeusArbExecutor: Aave V3 + Morpho Blue + Balancer V2 (Morpho/Balancer **0% fee**, multi-fonte) + **multi-hop N steps**.

**Motor 1 — Liquidations (5 protocolos):** Aave V3 · Compound III · Morpho Blue · Seamless (fork Aave) · Moonwell (fork Compound V2). Discovery on-chain (event scan + BorrowerCache acumulativo) + subgraph. Pipeline com gates (kill/cooldown/dedup/gas/stale) + EIP-1559 + caixa-preta (intelligence DuckDB). **OIE prioriza Morpho via OEV haircut.**

**Multi-chain code-ready (Motor 1):** Base · Arbitrum · Optimism · **Polygon** · **Avalanche** — endereços verificados na fonte (aave-address-book, Uniswap sdk-core, LFJ docs).

**Motor 2 — Cross-DEX Arb (MIS scanner → motor de execução):** `apps/mis-scanner` — pricing local (UniV3 tick / Aero / Trader Joe LB), varredura em multicall, derivação on-chain de colaterais dos protocolos, flash estimator via quoter, **sizing ótimo do empréstimo** + gate de profundidade (descarta pool raso) + **persistência no ledger**. Ranqueia por PERSISTÊNCIA. **Virou motor de EXECUÇÃO cross-DEX** (`arbDispatcher` + `arbOpportunity` + config de execução zod) + **detecção de arbitragem TRIANGULAR** (grafo + ciclos `findTriangularCycles`, read-only por enquanto). **Execução DESLIGADA por default** (`ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun`) — sem env deliberada continua só observando (`mis_observed`). Travas de segurança: circuit breakers na config zod (`MAX_TRADE_ETH` / `MIN_ARB_PROFIT_USD` / slippage), `EXECUTOR_PRIVATE_KEY` EXCLUSIVA, simula (`eth_call`) + EV gate ANTES de disparar, re-cota fresco, flashloan-only/atômico. Espelha toda a inteligência (EventBus, PnlReconciler, CompetitorResolver, market-bribe, auto-calibração).

**Motor 3 — Backrun:** `apps/backrun-engine` — planner + bribe + bundling (Flashbots/Atlas/Blocknative) + **EV gate competitor-aware** (gas war priors) + trackers + **PnlAggregator/Drift + post-mortem** (últimas pontas fechadas). Expõe `/metrics`. **BLOQUEADO em prod:** feed de mempool (`subscribeWhaleSwaps`) é placeholder — precisa Flashblocks WS / Alchemy Growth+. Backrun ainda força Aave 0,05% (seletor flashloan semi-ligado, sem impacto hoje).

**Discovery + detector:** `apps/discovery-scraper` (varredura GeckoTerminal → auto-targets) alimenta `apps/detector` (arb radar, consome varredura dinâmica + grava no ledger DuckDB).

**Camada OIE (2026-06-15) — Opportunity Intelligence Engine:** scoring puro (Opportunity / Protocol / Pool / Token) + ledger DuckDB (`packages/execution-utils/src/scoring/`). Gates EV plugados: **backrun competitor-aware** (gas war) + **liquidator ciente de OEV** (prioriza Morpho). Detector + MIS gravam observações no ledger em DRY_RUN. **OIE completa:** todos os sinais (market-bribe, competidores, reconciliação PnL, falhas, sybil, dedup, latência) → ledger DuckDB + **Prometheus + Grafana**; market-bribe alimenta o BribeCalculator. **Etapa C (thresholds adaptativos): ✅ FEITO, opt-in** (`ADAPTIVE_THRESHOLDS_ENABLED=false` default). **Etapa D (Grafana): parcial** — `DimensionMetricsExporter` (DuckDB→Prometheus) + 3 dashboards (operations/performance/rankings; meta original era 8). Deploy Fly.io (Dockerfile + `deploy/fly/*.toml`, volume persistente). Ver [`docs/OIE_PROGRESS.md`](./docs/OIE_PROGRESS.md).

**Validação contra mainnet (fork via Alchemy):** fork tests verdes incluindo prova de LUCRO ponta-a-ponta dos 3 motores (`MotorsProfit.fork.t.sol`; Motor 1 liquidação realista, Motor 2/3 com gap inflado de propósito pra provar a mecânica). Endereços/ABIs/premium flashloan confirmados nas chains via eth_call.

- **Total**: contratos **78/79 unit + fork verde** · **~404 testes TS** (execution-utils 336/336) · **13/13 typecheck**. Zero falha.

### 🔍 Aprendizados consolidados (Doutrina de Edge)

- **Edge NÃO é velocidade** (perdemos pros bots top em blue-chips) — é **cobertura + persistência** em pares sub-servidos (LSDs, stables fragmentadas) e protocolos de nicho (Morpho/Moonwell/Seamless).
- **Achado estratégico (2026-06-15):** liquidação na Base está se fechando por **OEV capture** — Aave V3 ~85% (Chainlink SVR), Moonwell ~99% (MEV tax on-chain). **Morpho Blue continua ABERTO (0% recapture) = único edge real em liquidação.** Estratégia decantada: **núcleo = liquidação Morpho** (lumpy, paga no crash) + **baseline = arb cross-DEX** (pequeno, contínuo, paga a infra). Ver [`docs/refs/engine-strategy.md`](./docs/refs/engine-strategy.md) + [`competitive-landscape.md`](./docs/refs/competitive-landscape.md) + [`morpho-profit-projection.md`](./docs/refs/morpho-profit-projection.md).
- **Nota competitiva honesta:** **~7,5/10 como software/engenharia · ~4,5/10 como competidor que ganha dinheiro hoje** (falta fosso de orderflow/latência + edge comprovado).
- **Lucro real até hoje = US$ 0:** lógica provada (fork), mas não deployado. Oportunidade real exige movimento de mercado + ganhar a corrida + dias de coleta do MIS/ledger.

### 🎯 Em andamento / próximos passos

- **Deploy mainnet** dos 4 contratos (técnico) + capital + multisig.
- **2 semanas DRY_RUN** mainnet + dias de coleta do MIS/ledger pra persistência emergir.
- **OIE Etapa C** (thresholds adaptativos) ✅ feito (opt-in) + **Etapa D** (dashboards Grafana) parcial (3 de 8). Ver [`docs/OIE_PROGRESS.md`](./docs/OIE_PROGRESS.md).
- **RPC pago + Fly.io** pra rodar MIS/discovery 24/7 (dRPC free serve reads; fork test usa Alchemy).

### 📅 Roadmap futuro

**Tese de 3 motores descorrelacionados:** Motor 1 ganha em CRASH · Motor 2 em VOLUME · Motor 3 em VOLATILIDADE.

| Item | Status |
|---|---|
| 4 contratos + 5 protocolos + multi-chain code-ready | ✅ |
| Flashloan 3 fontes (Aave/Morpho/Balancer, 0% multi-fonte) + multi-hop N steps | ✅ |
| Motor 2 MIS → motor de execução cross-DEX/triangular (execução OFF default) + Trader Joe LB (Avalanche) + persistência no ledger | ✅ |
| Motor 3 backrun engine (EV gate competitor-aware + bribe) | ✅ código |
| Discovery scraper (GeckoTerminal → auto-targets) + detector no ledger | ✅ |
| Camada OIE: scoring + ledger DuckDB + gates OEV/competidor + deploy Fly.io | ✅ |
| Fork tests de lucro dos 3 motores (Alchemy) | ✅ contratos 78/79 unit + fork verde |
| Deploy mainnet (4 contratos) + capital + multisig | ❌ (testnet only) |
| 2 semanas DRY_RUN + coleta MIS/ledger | 🟡 próximo |
| OIE Etapa C (thresholds adaptativos, opt-in) | ✅ |
| OIE Etapa D (Grafana) | 🟡 parcial (3 de 8 dashboards) |
| Motor 3 ao vivo (mempool premium ~$199/mês) | ❌ pós-receita |
| Audit externo (capital > $50k) | ❌ |

---

## 🔑 Decisões já tomadas

- ✅ Chain inicial: **Base**; code-ready: Arbitrum, Optimism, Polygon, Avalanche
- ✅ Motor 1 (Liquidations): **5 protocolos** (Aave V3 + Compound III + Morpho Blue + Seamless + Moonwell)
- ✅ **3 motores descorrelacionados**: Liquidations (1) + Cross-DEX Arb/MIS (2) + Backrun (3)
- ✅ Princípio inviolável: **FLASHLOAN-ONLY** até primeiro lucro real ([[project-zeus-evm-capital-principle]])
- ✅ Edge = **cobertura + persistência** em sub-servidos (NÃO velocidade). Motor 2 mira ineficiência persistente, não pico de 1 bloco
- ✅ Repo: `github.com/Opresida/zeus-evm`
- ✅ Stack: TypeScript + viem + Foundry (Solidity 0.8.27 + via_ir + 1M optimizer runs)
- ✅ Flashloan provider: Aave V3 universal (0.05% fee)
- ✅ Owner em prod: multisig Safe Wallet
- ✅ Provider RPC dev: dRPC free tier; prod: Alchemy Growth ($49/mês)
- ✅ Carteira testnet dedicada: `0xE060821b253ec9dad4BDe139c5661Bc07A6AcBB4`
- ✅ Contratos v8 split deployados em **Sepolia (testnet), NÃO mainnet**
- ✅ Audit externo recomendado: Trail of Bits / Spearbit (NÃO Certik) — quando capital > $50k
- ✅ Audit interno (Pass 1 + Pass 2) substitui Certik provisoriamente (decisão Humberto 2026-05-25)
- ✅ **Estratégia de receita (2026-06-15):** núcleo = liquidação **Morpho** (único edge aberto pós-OEV) + baseline = arb cross-DEX pequeno e contínuo (paga a infra). Backrun adiado.
- ✅ **Camada OIE adotada** (scoring + ledger DuckDB) — Etapas A/B feitas; gates EV opt-in via `MIN_OPPORTUNITY_EV_USD`.
- ✅ **Deploy via Fly.io** com volume persistente pro ledger (Dockerfile + `deploy/fly/*.toml`).
- ✅ Histórico de trades: **ledger DuckDB** (single-writer, volume persistente Fly.io) — substitui a dúvida Postgres.

## 🤔 Decisões abertas

- ❓ **Deploy mainnet** dos 4 contratos — gatilho: checklist pré-mainnet verde + capital + multisig definidos
- ❓ **Multisig provider** concreto: Safe Wallet (padrão) vs alternativa — antes do deploy mainnet
- ❓ **Capital inicial** concreto — código abstrai; decidir antes do deploy mainnet
- ❓ **Audit provider** externo (Trail of Bits / Spearbit) — antes de capital > $50k
- ❓ **Mempool premium** ($199-499/mês) pro Motor 3 ao vivo — gatilho: receita > $1k/mês

## ⚠️ Checklist obrigatório pré-mainnet

Ver seção dedicada no [TODO.md](./TODO.md). 22 itens em 5 categorias (thresholds / circuit breakers / operacional / infra / audit). Nada dispatcheado em mainnet sem checklist verde.

---

## 📂 Arquivos de documentação

| Arquivo | Propósito |
|---|---|
| `README.md` | Pitch, instalação, comandos, roadmap |
| `CONTEXT.md` | Regras, padrões, voz, princípios de risco |
| `PROJECT_CONTEXT.md` | Este arquivo — visão consolidada e status |
| `ARCHITECTURE.md` | Fluxos de dados, decisões técnicas, schema |
| `TODO.md` | Concluído + pendente detalhado |
| `CONTRACTS.md` | Spec de smart contracts + audit pipeline |
| `CLAUDE.md` | Pacote portátil pra IA |

---

## 👥 Time

- **Humberto** — product, strategy, decisões executivas
- **Claude (Anthropic)** — engineering, implementação, validação

> Decisão explícita: Danton (engineer do Zeus Solana) NÃO está envolvido no Zeus EVM. Projeto exclusivo Humberto + Claude.

Comunicação: direta, PT-BR.
