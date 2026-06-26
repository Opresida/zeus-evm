# ARCHITECTURE — ZEUS EVM

Estrutura de pastas, fluxos de dados e decisões arquiteturais.

---

> ## 🔄 ESTADO ATUAL (2026-06-17) — o que mudou desde o snapshot abaixo
>
> Este doc descreve fluxos que **continuam válidos conceitualmente**, mas a implementação evoluiu.
> Mapeamento do que está desatualizado no texto antigo:
>
> | No texto antigo | Estado atual |
> |---|---|
> | `ZeusExecutor v6` (1 contrato monolítico, 5 `execute*`) | **4 contratos v8 (split por EIP-170):** ZeusArbExecutor (arb/flashloan/backrun) + ZeusLiquidator (Aave/Compound/Morpho) + ZeusMoonwellLiquidator + BribeManager (bribe/coinbase) |
> | 3 protocolos (Aave/Compound/Morpho) | **5:** + Seamless (fork Aave) + Moonwell (fork Compound V2, contrato próprio) |
> | Flashloan só Aave V3 (0,05%) | **3 fontes via `FlashSource` enum:** Aave (0,05%) · Morpho (0%) · Balancer (0%) |
> | Cross-DEX "radar passivo / dead-end" | **Motor 2 = MIS scanner → motor de EXECUÇÃO cross-DEX/triangular** (`apps/mis-scanner` + `MarketInefficiencyScanner`): pricing local + multicall + derivação on-chain + flash sizing + gate de profundidade + ranking por persistência; ganhou `arbDispatcher` + `arbOpportunity` + detecção triangular (`findTriangularCycles`). **Execução OFF por default** (`ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun`) → sem env continua só observando (`mis_observed`) |
> | Backrun "planejado" | **`apps/backrun-engine` construído** (planner + bribe + bundling, `executeFlashloanBackrun`); falta mempool premium |
> | 4 trackers no `apps/liquidator` | **package `@zeus-evm/execution-utils`** compartilhado: trackers + gasOracle + eventBus + intelligence (OIE) + pnl + scoring + observability + health |
> | Sem ledger / persistência no MVP | **Ledger OIE em DuckDB** (`logs/intelligence.duckdb`, `INTELLIGENCE_DB_PATH`): observação + execução gravam eventos; scoring/ranking de pares (ver Fluxo 4) |
> | 4 apps (detector/backtest/monitor/liquidator) | **7 apps:** + `mis-scanner` (motor 2) + `backrun-engine` (motor 3) + `discovery-scraper` (auto-targets) |
> | Chains: Base/Arb/OP (+Avax planejado) | **Code-ready: Base/Arb/OP/Polygon/Avalanche** |
> | DEXs: UniV3 · Aerodrome | + Velodrome (OP) + **Trader Joe LB** (Avalanche, AMM por bins) |
> | 53 Foundry tests | **contratos 78/79 unit + fork verde** (incl. prova de LUCRO dos 3 motores em `test/fork/MotorsProfit.fork.t.sol`) · **~404 testes TS** (execution-utils 336/336) · 13/13 typecheck |
>
> Os fluxos 1/2/3 abaixo (executeArbitrage / executeFlashloanArbitrage / liquidation) continuam corretos —
> só estão hoje distribuídos entre ZeusArbExecutor e ZeusLiquidator em vez de um único ZeusExecutor.
>
> **🆕 2026-06-23 — DEX adapters do Motor 2 + cola do painel:**
> - Novos `DexType`: `Slipstream=5` (Aerodrome CL, `SlipstreamLib`) e `PancakeV3=6` (`PancakeV3Lib`, struct com deadline — Pancake **e Sushi V3** na Base). UniV2 genérico via `UniswapV2Lib`. Off-chain config-driven (`routerStyle` por fork). `DexType` com fonte única em `shared-types` + pin test.
> - **Cola de eventos (bot → painel):** `apps/mis-scanner` liga o `genericWebhookSink` (header `x-zeus-secret`) ao eventBus → POST em `frontend/app/api/ingest` → Supabase `events` → Realtime → painel. Emite `zeus.heartbeat` (30s) direto pelo sink (não pelo bus → fora do ledger DuckDB). Toggle reverso: painel → `/api/control` → Supabase `engine_control` → bot poll.
> - **RPC:** Alchemy primário (archive no free). Fork tests via `BASE_RPC_ARCHIVE` (`pnpm contracts:test:fork`).
>
> **🆕 2026-06-26 — módulos novos (mergeado na `main`):**
> - **Motor 1 / Pré-liquidação:** `apps/liquidator/src/protocols/morpho-preliq/` (math/factory/discovery/calculator/
>   builder/simulator/runner — a "caça" automática roda no `discoveryTick`) + `apps/liquidator/src/walletPool/`
>   (walletPool/noncePool/exposureBreaker/funding/**orchestrator** plugado no dispatch). Default OFF.
> - **Motor 2 / Filler:** `apps/mis-scanner/src/uniswapx/` (types/abi/evaluator/builder/orderFeed/runner/tokens +
>   `v4/quoter`) — recebe ordens do feed da API UniswapX (reativo), bestQuote compara V3 vs **V4**. Default OFF.
> - **Contratos:** satélites `ZeusMorphoPreLiquidator` + `ZeusUniswapXFiller` + `UniswapV4Lib` (Universal Router + Permit2).
> - ⚠️ **Observabilidade pendente:** filler só loga (não emite pro Supabase); pré-liq não reporta candidatos do DRY_RUN ao painel. Fiar na próxima sessão.
>
> **🆕 2026-06-25 parte 3 — Painel: login MAZARI + branding + UX (deployado na Vercel):**
> - **Auth:** painel atrás de **Supabase Auth** (login obrigatório em prod; demo sem login local). Tabelas
>   `profiles` (role/status) + `invites` + `is_admin()` + RLS (events/service_status/wallet → `authenticated`;
>   `engine_control` segue anon p/ o bot). **Cadastro por indicação** (admin) → `pending` → **admin aprova**.
>   Membro = só vê; **armar o bot = admin-only** (UI + `requireAdmin` server-side em `/api/control`). Helpers
>   `lib/authClient.ts`/`lib/authServer.ts`; rotas `/api/auth/signup`, `/api/admin/invite|approve`.
> - **Branding:** `public/brand/mazari-logo.png` (login) + `public/icons/zeus-*.png` (app icon PWA + favicon).
> - **UX:** `components/ZeusLoader.tsx` + `app/loading.tsx`; AuthGate faz **splash ≥4s** + **crossfade** p/ login;
>   **botão Sair** na topbar; **selo de MODO** (DRY-RUN/ARMADO/LIVE, do heartbeat — `viewModel.modeBadge`).
>
> **🆕 2026-06-25 parte 2 — reuso cross-motor (sem código novo de lógica):**
> - **Motor 2 herda as defesas do Motor 1** (todas de `@zeus-evm/execution-utils`, dormentes em DRY_RUN): reorg awareness (`FinalityTracker`→`onReorg`→`AutoPauseManager`/`OrphanRecoveryManager`/`ReorgAnalytics` + `TxStateMachine` no dispatch) + auto-pause de saúde (`AutoPauseManager`+`BlockStalenessCheck`+`ProcessCheck`, gate pré-simulação no `arbDispatcher`; antes o health server do M2 era "vazio") + `LatencyTracker` (p50/p95 no heartbeat).
> - **Gorjeta competitiva auto-ligável no M2:** `calculateCompetitiveBribe` (teto de lucro) + detector `gas_outbid` que liga sozinho + heartbeat `competitiveBribeAutoEnabled`. OFF default. Ganho modesto na Base FCFS.
> - **Arb triangular:** detecção segue read-only; caminho de execução planejado em `docs/TRIANGULAR_EXECUTION_PLAN.md` (atrás do MESMO toggle, sub-flag `TRIANGULAR_EXECUTION_ENABLED`). Banner "Lucro provado…" na Home.

## 🧭 Visão geral

ZEUS EVM é um **monorepo pnpm** com 3 camadas:

1. **`contracts/`** — Foundry project com smart contracts on-chain (Solidity)
2. **`apps/`** — Aplicações off-chain (TypeScript) que disparam transações
3. **`packages/`** — Bibliotecas compartilhadas entre apps

```
┌────────────────────────────────────────────────────────────────────┐
│                    ZEUS EVM (monorepo) — snapshot 2026-06-17       │
└────────────────────────────────────────────────────────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────┐  ┌────────────────────┐  ┌──────────────────────┐
│   contracts/    │  │       apps/        │  │    packages/         │
│   (Solidity v8) │  │    (TypeScript)    │  │   (shared TS)        │
│                 │  │                    │  │                      │
│ ZeusArbExecutor │  │ detector (motor 1) │  │ chain-config         │
│ ZeusLiquidator  │  │ mis-scanner (m2)   │  │ dex-adapters         │
│ ZeusMoonwell    │  │ backrun-engine(m3) │  │ strategy             │
│   Liquidator    │  │ liquidator (3 modos│  │ aave-discovery       │
│ BribeManager    │  │   dryrun/testnet/  │  │ execution-utils ★    │
│                 │  │   mainnet)         │  │ shared-types         │
│ libs: UniV3 ·   │  │ monitor (DRY_RUN)  │  │                      │
│   Aerodrome     │  │ backtest · discovery│  │ ★ = trackers + OIE  │
│                 │  │   -scraper         │  │   + scoring + pnl    │
└─────────────────┘  └────────────────────┘  └──────────────────────┘
        │                       │                       │
        └────────── interagem via viem + ABI ───────────┘
                            │              │
                            ▼              ▼
              ┌──────────────────────────────┐  ┌─────────────────────┐
              │  Chains (code-ready)         │  │  Ledger OIE (DuckDB)│
              │                              │  │  logs/intelligence  │
              │  Base (Coinbase L2)          │  │    .duckdb          │
              │  Arbitrum One · Optimism     │  │  observação +       │
              │  Polygon · Avalanche         │  │  execução → eventos │
              │                              │  │  → scoring/ranking  │
              │  Protocolos (liq):           │  │  (single-writer,    │
              │   Aave V3 · Seamless ·       │  │   unifica via ATTACH│
              │   Compound III · Morpho ·    │  └─────────────────────┘
              │   Moonwell                   │
              │  DEXs: UniV3 · Aerodrome ·   │
              │   Velodrome · Trader Joe LB  │
              │  Flashloan: Aave · Morpho ·  │
              │   Balancer                   │
              └──────────────────────────────┘
```

### Pipeline do `apps/liquidator` (Sprint 1 + 2 + Backend Completo)

```
┌──────────────────────────────────────────────────────────────────┐
│  PIPELINE PRE-DISPATCH GATES (5 fusíveis ortogonais)             │
├──────────────────────────────────────────────────────────────────┤
│  Gate 1: PnL Tracker        — kill switch se loss 24h ≥ $X       │
│  Gate 2: Failure Tracker    — cooldown se N falhas seguidas      │
│  Gate 3: Gas Reserve        — bloqueia se balance < critical     │
│  Gate 4: Position Dedup     — bloqueia re-submit por TTL         │
│  Gate 5: QuoterV2           — sanity (calculator não funciona)   │
└──────────────────────────────────────────────────────────────────┘
                              │ (todos verde)
                              ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ 1. DISCOVERY │ ──→ │ 2. CALCULATOR│ ──→ │ 3. SIMULATOR │
└──────────────┘     └──────────────┘     └──────────────┘
  subgraph              binary search        eth_call
  + Multicall3          10+5 samples         valida revert
  HF batch              + UniV3 QuoterV2     + decoda erro
  resolve par           + slippage check     + estima gas
  (Aave) /              + cache TTL 60s
  event scan
  (Compound)
                              │
                              ▼
                  ┌─────────────────────────┐
                  │  Gate 6: STALE CHECK    │  ← NOVO (gap #8)
                  │  re-checa HF on-chain   │
                  │  (só em testnet/mainnet)│
                  └─────────────────────────┘
                              │
                              ▼
                  ┌──────────────────────────┐
                  │ 4. DISPATCHER             │
                  │  - GasOracle EIP-1559     │  ← NOVO (gap #5)
                  │  - markPending (dedup)    │
                  │  - sendTransaction        │
                  │  - waitForReceipt         │
                  └──────────────────────────┘
                              │
                              ▼
                  ┌──────────────────────────┐
                  │ 5. POST-PROCESS           │
                  │  - Event decoder          │
                  │  - PnL tracker record     │  → JSONL persist
                  │  - Failure tracker record │
                  │  - Dedup markConfirmed    │
                  │  - EventBus emit          │  → Discord/webhook
                  └──────────────────────────┘
```

**6 trackers internos rodando em paralelo** (hoje vivem em `@zeus-evm/execution-utils`, compartilhados entre liquidator/backrun):
- PnL Tracker (rolling 24h + auto kill on-chain) — `pnlTracker.ts`
- Failure Tracker (cooldown após N falhas) — `failureTracker.ts`
- Position Dedup (TTL por chave composta) — `positionDedup.ts`
- Gas Reserve (balance monitor + alertas) — `gasReserveTracker.ts`
- Gas Oracle (EIP-1559 cache por bloco) — `gasOracle.ts`
- EventBus (emit pra Discord/Generic/futuro WebSocket) — `eventBus.ts` + `events.ts`

**EV gate ciente de OEV (2026-06-15):** antes do dispatch, o liquidator consulta os scores do ledger OIE
(`opportunityScorer` + `chainProfitabilityScorer`) e **prioriza Morpho** (OEV / sem premium de flashloan).
O backrun usa um EV gate **competitor-aware** (gas war). O Motor 2 (mis-scanner), quando a execução está
ligada (off por default), também passa por simulação `eth_call` + EV gate antes de qualquer dispatch. Ver Fluxo 4.

**3 modos operacionais:**
- `dryrun`: pipeline completo SEM submit (alimenta cache + LOGA decisions teóricas + grava no ledger OIE)
- `testnet`: submit em chains Sepolia
- `mainnet`: submit em chains mainnet (requer checklist obrigatório)

---

## 📁 Estrutura completa

```
zeus-evm/
│
├── 📄 README.md
├── 📄 CONTEXT.md
├── 📄 PROJECT_CONTEXT.md
├── 📄 ARCHITECTURE.md          ← este arquivo
├── 📄 TODO.md
├── 📄 CLAUDE.md
├── 📄 CONTRACTS.md
│
├── 📄 package.json             # workspace root (pnpm-only)
├── 📄 pnpm-workspace.yaml      # com catalog de versoes
├── 📄 .gitignore
├── 📄 .env.example
│
├── contracts/                  # ═══ FOUNDRY PROJECT (v8 — split EIP-170) ═══
│   ├── foundry.toml            # solc 0.8.27 + via_ir + 1M runs + yul + chains aliases
│   ├── remappings.txt
│   ├── src/
│   │   ├── ZeusArbExecutor.sol         # Motores 1+3 — 3 funções execute*:
│   │   │                               #   executeArbitrage (wallet, capital próprio),
│   │   │                               #   executeFlashloanArbitrage,
│   │   │                               #   executeFlashloanBackrun (com bribe)
│   │   │                               #   SwapStep[] multi-hop N steps (→ triangular)
│   │   │                               #   FlashSource enum: Aave/Morpho/Balancer
│   │   ├── ZeusLiquidator.sol          # Liquidações Aave/Compound/Morpho (+ variantes WithBribe)
│   │   ├── ZeusMoonwellLiquidator.sol  # Moonwell (fork Compound V2) — contrato próprio
│   │   ├── BribeManager.sol            # pay() bribe ao block.coinbase + slippage floor (H-01 Pass 4)
│   │   ├── libraries/
│   │   │   ├── UniswapV3Lib.sol        # inline adapter SwapRouter02 (on-chain)
│   │   │   └── AerodromeLib.sol        # inline adapter Aerodrome Router (on-chain)
│   │   └── interfaces/
│   │       ├── IZeusExecutor.sol       # SwapStep, ArbitrageParams, DexType enum,
│   │       │                           #   FlashSource enum, errors customizados
│   │       ├── IZeusArbExecutor.sol · IZeusLiquidator.sol
│   │       ├── IZeusMoonwellLiquidator.sol · IBribeManager.sol
│   │       ├── aave/                   # IPool, IFlashLoanSimpleReceiver
│   │       ├── balancer/IBalancerVault.sol  # flashLoan (0% fee)
│   │       ├── compound/IComet.sol     # absorb, buyCollateral, isLiquidatable, quoteCollateral
│   │       ├── moonwell/IMoonwell.sol  # liquidateBorrow (fork Compound V2)
│   │       └── morpho/IMorpho.sol      # liquidate, flashLoan, position, idToMarketParams
│   ├── test/                           # 9 arquivos (4 unit + 5 fork) — 78/79 unit + fork verde
│   │   ├── BribeManager.t.sol               # 11 unit
│   │   ├── ZeusArbExecutor.t.sol            # 19 unit (kill switch, access, multi-hop)
│   │   ├── ZeusLiquidator.t.sol             # 29 unit
│   │   ├── ZeusMoonwellLiquidator.t.sol     # 20 unit
│   │   └── fork/                            # fork tests via Alchemy
│   │       ├── ZeusArbExecutor.fork.t.sol        # 9 — arb + flashloan (3 fontes)
│   │       ├── ZeusLiquidator.fork.t.sol         # 9 — liquidações reais
│   │       ├── BribeManager.fork.t.sol           # 9
│   │       ├── BribeManagerB6B7.fork.t.sol       # 6
│   │       └── MotorsProfit.fork.t.sol           # 3 — prova de LUCRO dos 3 motores
│   ├── script/
│   │   └── Deploy.s.sol                # chainId-based: Base/Arb/OP/Polygon/Avax × mainnet+sepolia
│   └── lib/                            # forge install deps (gitignored)
│
├── apps/
│   │
│   ├── detector/               # ═══ DETECTOR OFF-CHAIN (orquestração) ═══
│   │   ├── package.json        # @zeus-evm/detector
│   │   └── src/
│   │       ├── index.ts        # main loop: WSS subscribe → scan → filter → simulate
│   │       ├── smoke.ts        # script de diagnóstico (config + RPC + balance)
│   │       ├── config.ts       # Zod schema + load .env do monorepo root
│   │       ├── logger.ts       # pino structured (JSON em prod)
│   │       └── mempool/
│   │           └── blockSubscription.ts  # WSS Alchemy + retry + polling fallback
│   │
│   ├── backtest/               # ═══ REPLAY HISTÓRICO ═══
│   │   ├── package.json        # @zeus-evm/backtest
│   │   ├── src/index.ts        # replay N blocos com findCrossDexArb (paralelo)
│   │   └── runs/               # outputs JSON (gitignored)
│   │
│   ├── monitor/                # ═══ DRY_RUN MONITOR (3 protocolos) ═══
│   │   ├── package.json        # @zeus-evm/monitor
│   │   └── src/
│   │       ├── index.ts                  # discovery loops Aave + Compound + Morpho
│   │       ├── chainContext.ts            # resolve por CHAIN_ID
│   │       ├── healthFactor.ts            # HF check via Multicall3
│   │       └── protocols/
│   │           ├── aaveV3.ts              # subgraph candidates
│   │           ├── compoundV3.ts          # event scan chunked (free tier safe)
│   │           └── morpho.ts              # subgraph Messari-format (schema-fixed 2026-05-25)
│   │
│   ├── liquidator/             # ═══ LIQUIDATOR (Aave/Compound/Morpho + OEV-aware) ═══
│   │   ├── package.json        # @zeus-evm/liquidator
│   │   └── src/
│   │       ├── index.ts                  # boot + discoveryTick + processOpportunity
│   │       ├── config.ts                  # 3 modos + thresholds + trackers config
│   │       ├── chainContext.ts            # client + wallet opcional
│   │       ├── pipeline.ts                # runAavePipeline + runCompoundPipeline (gates)
│   │       ├── dispatcher.ts              # EIP-1559 + waitForReceipt + event emit
│   │       ├── staleCheck.ts              # re-check HF on-chain pre-submit
│   │       ├── eventDecoder.ts            # decode eventos *Executed + delta
│   │       └── protocols/
│   │           ├── aave/                  # calculator (binary search) + simulator + builder
│   │           └── compound/              # ABI + cometCache + discovery + calc + sim + builder
│   │       # trackers/gasOracle/eventBus/intelligence vêm de @zeus-evm/execution-utils
│   │
│   ├── mis-scanner/            # ═══ MOTOR 2 — MIS scanner → motor de EXECUÇÃO cross-DEX/triangular ═══
│   │   ├── package.json        # @zeus-evm/mis-scanner
│   │   └── src/                # pricing local + multicall + derivação on-chain + flash sizing +
│   │                           #   gate de profundidade; ranqueia por persistência; grava no ledger OIE.
│   │                           #   execution/ (arbDispatcher) + arb/ (arbOpportunity + triangular
│   │                           #   findTriangularCycles, read-only); config de execução zod (circuit
│   │                           #   breakers); inteligência espelhada (EventBus/PnL/competitor).
│   │                           #   EXECUÇÃO OFF default (ARB_EXECUTION_ENABLED=false/ARB_MODE=dryrun)
│   │                           #   → sem env só grava mis_observed
│   │
│   ├── backrun-engine/         # ═══ MOTOR 3 — backrun de dislocação ═══
│   │   ├── package.json        # @zeus-evm/backrun-engine
│   │   └── src/                # planner + bribe + bundling (executeFlashloanBackrun);
│   │                           #   EV gate competitor-aware (gas war) + PnlAggregator/Drift + post-mortem;
│   │                           #   expõe /metrics. BLOQUEADO em prod: feed de mempool
│   │                           #   (subscribeWhaleSwaps) é placeholder → precisa Flashblocks WS/Alchemy Growth+
│   │
│   └── discovery-scraper/      # ═══ AUTO-TARGETS (amplia cobertura do detector) ═══
│       ├── package.json        # @zeus-evm/discovery-scraper
│       └── src/                # descobre pares; gera auto-targets consumidos por getTargetPairsForChain
│
├── packages/
│   │
│   ├── chain-config/           # ═══ CONFIGURACOES POR CHAIN ═══
│   │   ├── package.json        # @zeus-evm/chain-config
│   │   └── src/
│   │       ├── base.ts / arbitrum.ts / optimism.ts   # mainnet configs
│   │       ├── base-sepolia.ts / arbitrum-sepolia.ts / optimism-sepolia.ts
│   │       ├── target-pairs.ts             # 5 pares: WETH/USDC, cbETH/WETH, ...
│   │       ├── types.ts                    # ChainConfig type
│   │       └── index.ts                    # CHAINS registry
│   │
│   ├── dex-adapters/           # ═══ ADAPTERS TS (OFF-CHAIN PRICING) ═══
│   │   ├── package.json        # @zeus-evm/dex-adapters
│   │   ├── src/
│   │   │   ├── uniswapV3.ts                # quoteUniswapV3 via QuoterV2
│   │   │   ├── aerodrome.ts                # quoteAerodrome via Router.getAmountsOut
│   │   │   ├── types.ts                    # Quote, DexType, QuoteResult
│   │   │   └── index.ts
│   │   └── tests/                          # 6 vitest tests contra Base mainnet
│   │
│   ├── strategy/               # ═══ LÓGICA DE DETECÇÃO + EXECUÇÃO ═══
│   │   ├── package.json        # @zeus-evm/strategy
│   │   └── src/
│   │       ├── opportunities/
│   │       │   ├── crossDex.ts             # findCrossDexArb (radar passivo)
│   │       │   ├── quoteFanout.ts          # parallel quotes across DEXs
│   │       │   └── filters.ts              # min profit, slippage, gas, flashloan fee
│   │       ├── executor/
│   │       │   ├── txBuilder.ts            # buildArbitrageCalldata + buildFlashloanCalldata
│   │       │   ├── simulator.ts            # eth_call + estimateGas + decode errors
│   │       │   └── abi.ts                  # ABI completa ZeusExecutor (Aave + Compound + Morpho)
│   │       └── index.ts                    # re-exports
│   │
│   ├── aave-discovery/         # ═══ SHARED DISCOVERY PACKAGE ═══
│   │   ├── package.json        # @zeus-evm/aave-discovery
│   │   └── src/
│   │       ├── abi.ts                      # ABIs Pool/PoolDataProvider/AddressesProvider
│   │       ├── logger.ts                   # LoggerLike interface pino-compatible
│   │       ├── types.ts                    # AaveCandidate + AaveLiquidatablePosition
│   │       ├── reserves.ts                 # buildAaveReservesCache (1x boot)
│   │       ├── discovery.ts                # pipeline subgraph→Multicall3→par dominante
│   │       └── index.ts                    # re-exports
│   │
│   ├── execution-utils/        # ═══ PACOTE GRANDE COMPARTILHADO (trackers + OIE) ═══
│   │   ├── package.json        # @zeus-evm/execution-utils
│   │   └── src/
│   │       ├── pnlTracker.ts · failureTracker.ts · positionDedup.ts · gasReserveTracker.ts
│   │       ├── gasOracle.ts (EIP-1559) · eventBus.ts · events.ts · slippageCache.ts
│   │       ├── eventDecoder.ts · priceUtils.ts · bribeSlippageFloor.ts
│   │       ├── intelligence/                # OIE: TimeseriesStore (DuckDB) + EventIngester
│   │       │                                #   + observation + intelligenceSchema
│   │       ├── pnl/                          # pnlReconciler + attributionAnalyzer + aggregator
│   │       ├── scoring/                      # chainProfitabilityScorer + opportunityScorer
│   │       │                                #   + dimensionScorer + dimensionStatsQuery
│   │       ├── analytics/                    # failureCollector + reporter + competitorResolver
│   │       ├── competitors/                  # senderRegistry + classifiers + builder attribution
│   │       ├── arc/MarketInefficiencyScanner # motor 2 core + tokenSafety + triangular (findTriangularCycles)
│   │       ├── observability/                # prometheusExporter + structuredLogger + tracer
│   │       ├── health/ · finality/ · oracle/ · mempool/ · protocols/
│   │       └── index.ts
│   │
│   └── shared-types/           # ═══ TIPOS COMPARTILHADOS ═══
│       ├── package.json        # @zeus-evm/shared-types
│       └── src/
│           ├── swap.ts                 # SwapStep, ArbitrageParams, DexType, FlashSource (mirror Solidity)
│           └── index.ts
│
└── docs/refs/                  # ═══ MATERIAL EXTERNO PRA IA ═══
    # Humberto coloca aqui MDs com referencias:
    # - audit-mindset.md
    # - flashloans-evm.md
    # - mev-patterns.md
    # - gas-optimization.md
    # - liquidations-mev.md
```

---

## 🌊 Fluxos de dados

### Fluxo 1 — Cross-DEX arb (Modalidade Capital Próprio)

```
[apps/detector]
  │
  │ (1) Subscribe a pending txs do mempool via Alchemy WSS
  │
  ├──► Mempool listener (alchemy.ts)
  │       │
  │       │ (2) Detecta swap grande (>$10k) em DEX X
  │       │
  │       ▼
  │     opportunities/crossDex.ts
  │       │
  │       │ (3) Calcula preço esperado pos-swap em DEX X
  │       │ (4) Compara com preço atual em DEX Y
  │       │ (5) Se gap > minProfitUsd + custos:
  │       │     monta SwapStep[] {DEX Y → DEX X}
  │       │
  │       ▼
  │     executor/simulator.ts
  │       │
  │       │ (6) eth_call no ZeusExecutor pra confirmar profit
  │       │ (7) Se simulação OK:
  │       │
  │       ▼
  │     executor/txBuilder.ts
  │       │ (8) Codifica calldata do executeArbitrage(params)
  │       │
  │       ▼
  │     executor/submitter.ts
  │           (9) walletClient.sendTransaction(...)
  │           (10) Espera receipt
  │
[chain: Base mainnet]
        │
        ▼
   [ZeusExecutor.sol :: executeArbitrage]
        │
        │ (a) require(!killed)
        │ (b) require(msg.sender == owner ou operator)
        │ (c) require(params.amountIn <= MAX_TRADE_ETH)
        │
        ├──► for each SwapStep in params.steps:
        │       call dex-adapter.swap(step)
        │
        │ (d) Computa profit final
        │ (e) require(profit >= params.minProfitWei) ELSE revert
        │ (f) Transfer profit → profitReceiver
        │ (g) emit ArbitrageExecuted
        │
        ▼
[apps/detector] recebe receipt, atualiza métricas
```

### Fluxo 2 — Flashloan arb (Modalidade Flashloan, multi-fonte)

> Hoje mora em `ZeusArbExecutor`. A fonte do flashloan é escolhida off-chain via `FlashSource` enum:
> **Aave** (0,05% premium) · **Morpho** (0%, repago via singleton) · **Balancer** (0%, repago via Vault).
> O callback e o estilo de repago variam por fonte; o exemplo abaixo usa Aave.

```
[apps/detector / backrun-engine]
  │
  │ (1) Motor identifica oportunidade que precisa size > capital próprio
  │ (2) Chama executeFlashloanArbitrage(src, asset, amount, params)  (src = FlashSource)
  │
[ZeusArbExecutor.sol :: executeFlashloanArbitrage]
  │
  │ (a) IPool(aaveV3).flashLoanSimple(this, asset, amount, params, 0)   (caso Aave)
  │
  ▼
[Aave V3 Pool]
  │ (b) Transfere `amount` de `asset` → ZeusExecutor
  │ (c) Chama ZeusArbExecutor.executeOperation(asset, amount, premium, initiator, params)
  │
[ZeusArbExecutor.sol :: executeOperation (callback Aave)]
  │
  │ (d) Decode params → ArbitrageParams
  │ (e) for each SwapStep: execute swap
  │ (f) require(balance(asset) >= amount + premium) ELSE revert
  │ (g) approve(aaveV3, amount + premium)
  │ (h) profit = balance(profitToken) - (amount inicial em profitToken se aplicável)
  │ (i) require(profit >= params.minProfitWei) ELSE revert
  │ (j) Transfer profit → profitReceiver
  │
  ▼
[Aave V3 Pool]
  │ (k) Puxa `amount + premium` de volta de ZeusExecutor
  │
  ▼
[apps/detector] recebe receipt
```

### Fluxo 3 — Liquidations

```
[apps/monitor]
  │
  │ (1) Loop: a cada 2s, lê posições do Aave V3
  │ (2) Calcula health factor de cada posição
  │ (3) Se HF < 1.0 detectado em position com debt > minSize:
  │
  ├──► protocols/aaveV3.ts
  │       (4) Calcula collateral + bonus disponível
  │       (5) Calcula custo: gas + flashloan fee + swap slippage
  │       (6) Se profit líquido > MIN_PROFIT_USD:
  │
  ▼
[ZeusLiquidator.sol :: executeLiquidation / executeCompoundLiquidation / executeMorphoLiquidation]
  │   (Moonwell → ZeusMoonwellLiquidator.executeMoonwellLiquidation)
  │   (variantes *WithBribe chamam BribeManager.pay() ao block.coinbase)
  │
  │ (a) flashloan(debtAsset, debtAmount)   (FlashSource: Aave/Morpho/Balancer)
  │ (b) callback executeOperation:
  │       i)   protocol.liquidationCall(user, collateralAsset, debtAsset, debtAmount, false)
  │       ii)  recebe collateral + bonus
  │       iii) swap collateral → debtAsset (pra repagar flashloan)
  │       iv)  approve/transfer pra repay (estilo varia por fonte)
  │       v)   profit residual → profitReceiver
```

### Fluxo 4 — OIE: ledger DuckDB → scoring/ranking (DRY_RUN, 2026-06-15)

```
  OBSERVAÇÃO                               EXECUÇÃO
┌──────────────────┐                  ┌─────────────────────┐
│ detector (arb)   │                  │ liquidator          │
│ mis-scanner (MIS)│                  │ backrun-engine      │
└────────┬─────────┘                  └──────────┬──────────┘
         │ buildObservationEvent                 │ eventos de execução
         │ (arb_observed / mis_observed)         │ (dispatch / fill / pnl)
         ▼                                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Ledger DuckDB — logs/intelligence.duckdb                     │
│  (path via INTELLIGENCE_DB_PATH; volume persistente no Fly.io)│
│  DuckDB é SINGLE-WRITER → cada motor escreve SEU arquivo;      │
│  unificação só na CONSULTA via ATTACH (attachAndRankPairs)    │
└──────────────────────────────┬───────────────────────────────┘
                               │ queryTopOpportunityPairs
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Scoring (execution-utils/scoring)                            │
│  Scores: Opportunity · Protocol · Pool · Token                │
└──────────────────────────────┬───────────────────────────────┘
                               │ alimenta EV gates pré-dispatch
                               ▼
   ┌────────────────────────┐      ┌────────────────────────────┐
   │ Backrun: EV gate       │      │ Liquidator: EV gate         │
   │ competitor-aware       │      │ ciente de OEV               │
   │ (gas war)              │      │ (prioriza Morpho)           │
   └────────────────────────┘      └────────────────────────────┘
```

**Caminho de execução do Motor 2 (mis-scanner, OFF por default):** quando `ARB_EXECUTION_ENABLED=true`
(deliberado), o scanner não para na observação — um adaptador converte observação → `arbOpportunity`,
**re-cota fresco** → **simula (`eth_call`)** → passa pelo **EV gate** → só então `arbDispatcher` dispara
(flashloan-only/atômico, circuit breakers da config zod, `EXECUTOR_PRIVATE_KEY` exclusiva). A detecção
**triangular** (`findTriangularCycles`) hoje é read-only. Sem a env, o caminho de execução fica inerte e o
scanner só grava `mis_observed`.

Deploy: `Dockerfile` (raiz) + `deploy/fly/*.toml` com volume persistente obrigatório
pro ledger DuckDB. Guia: `docs/refs/fly-deploy.md`. Status detalhado: `docs/OIE_PROGRESS.md`.

---

## 🧩 Decisões arquiteturais

### Por quê Foundry e não Hardhat?
- **Velocidade:** `forge test` é 10-100x mais rápido que Hardhat
- **Fuzzing nativo:** property-based tests built-in
- **Solidity-first:** testes em Solidity (não JS), mais natural pra contratos
- **Forks nativos:** `vm.createFork()` é first-class
- **Comunidade:** Paradigm, Optimism, Aave V3 — todos usam Foundry hoje

### Por quê viem e não ethers?
- **Type safety nativo:** sem precisar declarar tipos manualmente
- **Mais leve:** ~20kb vs 180kb do ethers
- **Mais moderno:** novos protocolos suportam viem primeiro
- **Tree-shaking funciona:** ethers v6 ainda tem overhead

### Por quê monorepo pnpm e não nx/turborepo?
- Consistência com MAZARI (todos projetos do Humberto usam pnpm workspaces)
- `catalog:` resolve versão compartilhada sem ferramenta extra
- Tooling minimalista — não precisa de orchestrator pra esse tamanho

### Por quê via_ir + optimizer 1M runs?
- `via_ir` ativa o Yul intermediate representation = código mais otimizado
- 1M runs = otimiza pra execução (não pra deploy size) — hot path
- Trade-off: deploy custa mais gas, mas cada `executeArbitrage` é mais barato

### Por quê separar detector e monitor em apps diferentes?
- **Detector** roda em loop reativo (mempool subscription)
- **Monitor** roda em loop pollado (a cada N segundos)
- Diferentes características de carga → vale separar
- Podem rodar em hosts diferentes se precisar escalar

### Por quê não usar React Router pra dashboard?
- Sem dashboard inicial — todos os outputs vão pra logs estruturados + Discord alerts
- Dashboard é Fase futura (provavelmente Grafana ou app dedicado)

### Por quê Base como chain inicial e não Arbitrum?
- Coinbase ecosystem em alta (2025-26)
- Gas marginalmente mais barato que Arbitrum
- Aerodrome (DEX dominante) tem características únicas (ve(3,3) economics)
- Aave V3 ativo em ambas, mas Base tem maior crescimento de TVL
- Decisão pode ser revisada se Base perder momentum

---

## 🔌 Dependências externas planejadas

### Solidity (Foundry libs)
- `OpenZeppelin/openzeppelin-contracts` — Ownable2Step, ReentrancyGuard, Pausable, SafeERC20
- `Uniswap/v2-core` — interfaces UniV2 (pra adapters)
- `Uniswap/v3-core` + `v3-periphery` — Quoter, swap interfaces, TickMath
- `aave/aave-v3-core` — IPool, IFlashLoanReceiver
- `forge-std` — Test, Vm, console2

### TypeScript (npm)
- `viem` (catalog) — interação Web3
- `zod` (catalog) — validação de env e config
- `pino` (catalog) — logs estruturados
- `dotenv` (catalog) — load `.env`
- `tsx` (catalog) — execution
- `vitest` (catalog) — testes

---

## 🚢 Deploy planejado

### Etapa 1 — Local dev
- Foundry rodando contra fork local
- Detector em watch mode (`tsx watch`)

### Etapa 2 — Testnet Base Sepolia
- Deploy via `forge script` com verificação BaseScan
- Detector em Fly.io free tier
- Simulação por 2 semanas com mempool real (mas tx vão pra Sepolia, não mainnet)

### Etapa 3 — Mainnet com cap pequeno
- Deploy mainnet com `MAX_TRADE_ETH=0.1`
- Owner = multisig Safe Wallet
- Monitoramento Tenderly + Discord alerts
- Capital inicial: 0.5 ETH

### Etapa 4 — Scale
- Capital aumentado escalonadamente
- Multi-chain (Arbitrum + Optimism)
- Audit externo Certik

---

## 🗄️ Persistência

### Atual — Ledger OIE (DuckDB)
- **DuckDB embarcado** (`logs/intelligence.duckdb`, `INTELLIGENCE_DB_PATH`) — ledger de eventos OIE
- Single-writer: cada motor grava seu arquivo; unificação na consulta via `ATTACH`
- `TimeseriesStore` + `EventIngester` + `intelligenceSchema` em `execution-utils/intelligence`
- PnL persistido (JSONL + reconciler) · logs estruturados pino → arquivo + stdout
- Volume persistente no Fly.io obrigatório (ver `deploy/fly/*.toml`)

### Pós-mainnet (Fase 7+)
- **Neon Postgres** (padrão MAZARI)
- Tabelas:
  - `opportunities_detected` — histórico de oportunidades vistas (mesmo as não executadas)
  - `trades` — todas as txs executadas com profit, gas, blockNumber
  - `liquidations` — posições liquidadas
  - `health_factors_snapshot` — snapshot diário pra análise
- Drizzle ORM
- Dashboards via Grafana ou metabase

---

## 🧪 Testes

### Unit (Solidity, Foundry)
- Cada adapter: 5+ tests cobrindo happy path + edge cases
- Cada strategy: tests com mocks
- ZeusExecutor: invariants (profit obrigatório, kill switch funciona)

### Integration (Solidity, Foundry fork)
- `vm.createFork(BASE_RPC)` pra testar contra DEXs reais
- Simular trade real e verificar profit calculado bate

### Fuzzing (Solidity, Foundry)
- `forge test --fuzz-runs 100000` em funções críticas
- Invariant testing pra propriedades globais

### E2E (TypeScript, vitest)
- Detector + Foundry + anvil local rodando juntos
- Cenário: mempool simulado → detector identifica → contrato executa

---

## 📂 Arquivos relacionados

- [README.md](./README.md)
- [CONTEXT.md](./CONTEXT.md)
- [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)
- [TODO.md](./TODO.md)
- [CONTRACTS.md](./CONTRACTS.md)
- [CLAUDE.md](./CLAUDE.md)
