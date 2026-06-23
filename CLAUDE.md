# CLAUDE.md — ZEUS EVM

Pacote de contexto portátil para Claude Code. Auto-carregado em qualquer máquina onde este repo for clonado.

---

## 👤 Quem é o usuário

**Humberto** (humbertodeassuncao@gmail.com) — fundador da MAZARI CORP. Plano Claude Max. Usa **Antigravity IDE** no Windows.

### Preferências fortes
- **Nunca abrir Simple Browser nem browser embutido** — apenas informar URL
- **PT-BR direto**, vocativo "meu amigo" é OK
- **Respostas curtas e objetivas**, sem floreio
- **Honestidade > otimismo cego** — sempre flag limites e riscos

---

## 🎯 O que é o ZEUS EVM

Bot de arbitragem on-chain em EVM. **Duas modalidades:**
1. **Wallet arb** — capital próprio do bot
2. **Flashloan arb** — multi-fonte 0% (Morpho + Balancer primário, Aave V3 0.05% fallback)

**Três motores descorrelacionados:**
- **Motor 1 — Liquidations** (Aave V3 + Compound III + Morpho Blue + Seamless + Moonwell)
- **Motor 2 — MIS scanner → motor de execução cross-DEX** (varredura de ineficiências ranqueada por persistência + execução cross-DEX/triangular; **execução DESLIGADA por default** — `ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun`)
- **Motor 3 — Backrun** (backrun pós-whale, competitor-aware com bribe + relays)

**Estratégias de arb (motor de execução compartilhado):**
- Cross-DEX em medium-cap tokens
- Triangular / multi-hop N steps (Uniswap V3 fee tiers)

**Chain inicial:** Base (Coinbase L2). Multi-chain depois.

> Projeto exclusivo Humberto + Claude. Danton NÃO está envolvido.

---

## 🧱 Stack

- **Off-chain:** TypeScript + Node 22 + `viem`
- **Smart contracts:** Solidity 0.8.27 + Foundry (via_ir, optimizer 1M runs)
- **Monorepo:** pnpm 10+ workspaces (pnpm-only — npm install é bloqueado)
- **Provider:** Alchemy primário (archive incluso no free tier) + fallback a definir (dRPC free descartado — não serve archive)
- **Flashloan:** multi-fonte 0% — Morpho + Balancer primário, Aave V3 0.05% fallback
- **Intelligence:** ledger DuckDB (camada OIE — scoring + observações)
- **Deploy:** Fly.io (Dockerfile raiz + `deploy/fly/*.toml` com volume persistente)
- **Monitoring:** Tenderly + Discord webhook + pino logs + Prometheus + Grafana

---

## 🚀 Como rodar

```bash
cd /c/Users/user/zeus-evm

# Setup inicial (1ª vez)
pnpm install

# Foundry: instalar libs
cd contracts
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install Uniswap/v3-core --no-commit
forge install Uniswap/v3-periphery --no-commit
forge install aave/aave-v3-core --no-commit
cd ..

# Build contratos
pnpm contracts:build

# Tests
pnpm contracts:test

# Typecheck TS
pnpm typecheck
```

**Não abrir browser** — projeto é CLI + bot, sem UI até dashboard futuro.

---

## ✅ Princípios não-negociáveis

### Risco e segurança
1. **Atomic-only** — qualquer falha reverte a tx inteira
2. **Self-custody com circuit breakers no contrato** — `MAX_TRADE_ETH` + `minProfitWei` + kill switch
3. **Owner = multisig** (Safe Wallet) em produção
4. **Sem reuso de chave** entre projetos — chave do Zeus EVM é exclusiva
5. **Validar antes de escalar** — testnet 2 semanas → mainnet capital pequeno 4 semanas → audit → scale

### Código
1. **`pnpm typecheck && pnpm contracts:test` antes de "concluído"**
2. **`pnpm install` é proibido** — preinstall hook bloqueia
3. **Adapters DEX modulares** — 1 arquivo por DEX, interface comum
4. **Custom errors > require strings** (gas)
5. **NatSpec em funções públicas**
6. **Sem proxies upgradeable** — bug = deploy novo (intencional)

### Voz
- PT-BR direto
- Sem hype crypto-bro
- Sempre flag riscos antes de implementar
- "Posso entregar mas precisa audit antes de capital alto" é honesto

---

## 🔒 Regras invioláveis

- ❌ **Nunca** `npm install` neste repo
- ❌ **Nunca** commitar `.env` (use `.env.example`)
- ❌ **Nunca** deploy mainnet sem audit interno + testnet 2 semanas mínimo
- ❌ **Nunca** assumir que mainnet "vai funcionar" sem testar em fork
- ❌ **Nunca** reusar `EXECUTOR_PRIVATE_KEY` entre dev e prod
- ❌ **Nunca** modificar `MAX_TRADE_ETH` em runtime sem timelock
- ❌ **Nunca** skipar testes com `--skip`
- ❌ **Nunca** chamar adapter não-aprovado (`approvedDexAdapters`)
- ❌ **Nunca** acessar mainnet sem `KILL_SWITCH=false` deliberado

---

## 📁 Estrutura

```
zeus-evm/
├── contracts/              # Foundry — split por EIP-170 (4 contratos, antes era ZeusExecutor monolítico)
│   ├── src/ZeusArbExecutor.sol          # executeArbitrage + executeFlashloanArbitrage +
│   │                                    # executeFlashloanBackrun (multi-hop N steps = triangular;
│   │                                    # flashloan 3 fontes Aave/Morpho/Balancer)
│   ├── src/ZeusLiquidator.sol           # Liquidation (Aave) + Compound + Morpho (+ variantes WithBribe)
│   ├── src/ZeusMoonwellLiquidator.sol   # executeMoonwellLiquidation
│   ├── src/BribeManager.sol             # gestão de bribe pro motor 3
│   ├── src/libraries/                   # UniswapV3Lib + AerodromeLib (inline adapters)
│   ├── src/interfaces/                  # IZeusArbExecutor/IZeusExecutor/IZeusLiquidator/
│   │                                    # IZeusMoonwellLiquidator/IBribeManager
│   │                                    # + aave/balancer/compound/moonwell/morpho
│   ├── script/Deploy.s.sol              # multi-chain (Base, Arb, OP — mainnet + Sepolia)
│   └── test/                            # 115 funções de teste (9 arquivos: 4 unit + 5 fork)
│       ├── ZeusArbExecutor.t.sol  ZeusLiquidator.t.sol  ZeusMoonwellLiquidator.t.sol  BribeManager.t.sol
│       └── fork/                        # ZeusArbExecutor + ZeusLiquidator + BribeManager (+B6B7) + MotorsProfit
├── apps/                   # 7 apps
│   ├── detector/           # TS — radar arb cross-DEX DRY_RUN; consome getTargetPairsForChain (varredura)
│   │                       #      + grava no ledger DuckDB (arb_observed)
│   ├── liquidator/         # MOTOR 1 — pipeline completo; Aave V3 + Compound III + Morpho Blue +
│   │                       #           Seamless (fork Aave) + Moonwell; EV gate ciente de OEV (prioriza Morpho)
│   │   ├── src/protocols/aave|compound|moonwell|morpho/   # calc + sim + builder por protocolo
│   │   ├── src/alerting/   # discordSink + genericWebhookSink (subscribers do eventBus)
│   │   ├── src/pipeline.ts # runners Aave/Compound/Morpho/Moonwell + gates pre-dispatch + score pós-OEV
│   │   └── src/dispatcher.ts  # 3 modos: dryrun | testnet | mainnet + EIP-1559
│   ├── mis-scanner/        # MOTOR 2 — motor de execução cross-DEX (varredura multicall + derivação de
│   │                       #           colaterais até 60 pares + flash sizing + Trader Joe LB + detecção
│   │                       #           triangular findTriangularCycles); ranqueia por persistência;
│   │                       #           arbDispatcher/arbOpportunity (execução OFF default → só grava
│   │                       #           mis_observed) + inteligência espelhada (EventBus/PnL/competitor)
│   ├── backrun-engine/     # MOTOR 3 — backrun pós-whale; EV gate competitor-aware (gas war) + bribe +
│   │                       #           relays; grava no ledger
│   ├── discovery-scraper/  # TS — varredura dinâmica GeckoTerminal → auto-targets.json + token safety GoPlus
│   ├── monitor/            # TS — DRY_RUN discovery Aave+Compound+Morpho (read-only)
│   └── backtest/           # TS — replay histórico de blocos
├── packages/              # 6 packages
│   ├── chain-config/       # BASE_MAINNET + BASE_SEPOLIA + ARBITRUM + OPTIMISM + target-pairs
│   ├── dex-adapters/       # quoteUniswapV3 + quoteAerodrome (off-chain pricing)
│   ├── strategy/           # opportunities (crossDex/filters/fanout) + executor (txBuilder/simulator/abi)
│   ├── aave-discovery/     # package shared (ABIs + reserves cache + discovery + types) reusável
│   ├── execution-utils/    # PACOTE GRANDE — trackers (pnl/failure/dedup/gas) + gasOracle + eventBus/events
│   │                       #   + intelligence DuckDB (TimeseriesStore + EventIngester + observation)
│   │                       #   + pnlReconciler/attribution + failureCollector + senderRegistry
│   │                       #   + scoring (chainProfitability/opportunity/dimension/dimensionStatsQuery)
│   │                       #   + prometheus + health + MarketInefficiencyScanner + bribeSlippageFloor + Tracer
│   └── shared-types/
├── docs/                   # OIE_PROGRESS + FIRST_FLIGHT + INFRA_EVOLUTION + MOTOR3_REFIT + NO_EDGE_TOKENS + grafana/
│   └── refs/               # MDs externos pra expandir conhecimento da IA
├── frontend/               # ZEUS Command — painel Next.js (Vercel) que espelha o backend.
│                           # App STANDALONE (package.json próprio, FORA do pnpm workspace;
│                           # instalar com `pnpm install --ignore-workspace`). Ponte de dados:
│                           # bot genericWebhookSink → /api/ingest → Supabase Realtime → painel
│                           # + Web Push/Email. LER frontend/HANDOFF.md ANTES de mexer.
└── deploy/fly/             # Dockerfile raiz + detector/liquidator/mis-scanner.toml (volume persistente)
```

---

## 🆕 SESSÃO 2026-06-23 — DEX Motor 2 + toggle + cola do painel (tudo na `main`)

**Mergeado + corrigido (commits `fcfc7be`→`f57222d`):**
- **Expansão de DEX do Motor 2:** Slipstream (Aerodrome CL) + UniV2 genérico (forks) + forks UniV3.
  **Adapter `PancakeV3Lib` + `DexType.PancakeV3=6`** (struct `exactInputSingle` COM deadline).
  Achado verificado on-chain: **Sushi V3 na Base também precisa de deadline** → `routerStyle='pancakeV3'`.
- **DexType unificado** (era triplicado): fonte única em `shared-types` + re-export + **pin test**.
- **Toggle remoto "armado-mas-travado"** (Motor 2): painel→`/api/control`→Supabase `engine_control`→bot poll→gate. Fail-safe. `/api/control` POST fail-closed em prod.
- **Endereços de venue verificados on-chain** (Alchemy archive): vivos = BaseSwap/AlienBase/SwapBased/Pancake-v2/Sushi-v2 + Pancake V3 + Sushi V3 + Slipstream. **Removidos** dackieswap-v2 (router morto) e rocketswap (sem par curado).
- **RPC: Alchemy é PRIMÁRIO** (dRPC free descartado — não forka archive). `BASE_RPC_ARCHIVE` + `pnpm contracts:test:fork` plug-and-play.
- **CI:** fix do `forge install` (forge 1.x removeu `--no-commit`) + pin de libs + job `contracts-fork` (trap de endereços). 3 jobs verdes. **Falta setar o secret `BASE_RPC_ARCHIVE` no GitHub** pra ativar o trap.
- **Redeploy Base Sepolia v8** (com os adapters): BribeManager `0xe0B6…4795` · ZeusLiquidator `0x8E76…193D` · ZeusArbExecutor `0x0156…ab4A` · Moonwell `0x3A34…3dA3`. Liquidator+ArbExecutor com `revive()` + `setOperator(0xE060…cBB4)`.
- **Cola do painel (eventos bot→painel):** Supabase criado (projeto `kwmhuokedfmlvntovjtw`, schema.sql rodado). `genericWebhookSink` manda `x-zeus-secret`; **mis-scanner liga o sink + emite `zeus.heartbeat`** (30s, direto, não infla DuckDB). Novo `HeartbeatEvent`.

**🔜 Falta (próxima sessão):**
- **Vercel:** setar 4 envs (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ZEUS_WEBHOOK_SECRET) + redeploy → painel sai do demo.
- **Bot `.env`:** preencher `GENERIC_WEBHOOK_URL` = `<URL do painel Vercel>/api/ingest` (falta a URL).
- **Moonwell:** `revive()` + `setOperator()` (se usar Motor 1 Moonwell — ficou com kill switch ativo).
- **Subir a VM na Fly.io** + secrets dela; depois **2 semanas DRY_RUN** antes de cogitar mainnet.
- Mainnet (futuro): owner=multisig + operador separado (no testnet ficou owner==operador).

## 🗺️ Estado atual (snapshot 2026-06-15)

### ✅ Pronto

**Camada smart contract (v8 — split por EIP-170):**
- Antigo `ZeusExecutor` monolítico **dividido em 4 contratos**: `ZeusArbExecutor` (arb + flashloan arb +
  flashloan backrun, multi-hop N steps = triangular, flashloan 3 fontes Aave/Morpho/Balancer) +
  `ZeusLiquidator` (Aave/Compound/Morpho + variantes WithBribe) + `ZeusMoonwellLiquidator` + `BribeManager`
- Security Audit Pass 1+2 + fixes (H-01, H-02, M-01, M-02)
- Deployado e verified em 3 chains **testnet** Sepolia (Base/Arb/OP). **Ainda NÃO em mainnet.**
- **78/79 testes unit Foundry** (1 skip) + suíte fork verde (inclui `MotorsProfit.fork.t.sol`)

**Camada off-chain (3 motores + intelligence):**

*Liquidator (Motor 1):* pipeline completo com gates pre-dispatch + stale check pre-submit.
Cobertura **Aave V3 + Compound III + Morpho Blue + Seamless (fork Aave) + Moonwell** nas 3 chains.
Inclui os 6 gaps críticos (pnlTracker/failureTracker/positionDedup/gasReserveTracker/gasOracle/eventBus +
staleCheck) — hoje consolidados em `@zeus-evm/execution-utils`.

*MIS scanner (Motor 2):* virou **motor de execução cross-DEX** (`arbDispatcher` + `arbOpportunity` + config zod).
Varredura de ineficiências (multicall + derivação de colaterais até 60 pares + flash sizing + Trader Joe LB),
ranqueia por persistência + **detecção triangular** (grafo de tokens + `findTriangularCycles`, read-only por ora).
**Execução DESLIGADA por default** (`ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun` → só grava `mis_observed`).
Travas: circuit breakers (MAX_TRADE_ETH / MIN_ARB_PROFIT_USD / slippage) validados na config zod; `EXECUTOR_PRIVATE_KEY`
exclusiva; **simula (eth_call) + EV gate ANTES de disparar**; re-cota fresco no dispatch; **flashloan-only / atômico**
(falha = só gás). Espelha toda a camada de inteligência (EventBus, PnlReconciler, CompetitorResolver, market-bribe,
auto-calibração).

*Backrun engine (Motor 3):* backrun pós-whale; EV gate competitor-aware (via nível de gas war) + bribe +
relays; grava no ledger.
> ⚠️ **BLOQUEADO EM PROD:** a tubulação está pronta, mas o feed de mempool (`subscribeWhaleSwaps`) é
> **placeholder** — não assina `alchemy_pendingTransactions`, então nunca emite `whale.swap_detected`
> em produção (só via smoke test). Base não tem mempool público; precisa Flashblocks WS / Alchemy
> Growth+. **Motor 3 não dispara até resolver isso.** Detalhes em [docs/LOOSE_WIRES.md](./docs/LOOSE_WIRES.md).

*Discovery scraper:* varredura dinâmica GeckoTerminal → `auto-targets.json` + token safety GoPlus.
O detector consome via `getTargetPairsForChain`.

**Camada OIE — Opportunity Intelligence Engine (entregue 2026-06-15, grande novidade):**
- **Etapa A — scoring:** Opportunity/Protocol/Pool/Token Score + ledger **DuckDB**
  (fix: `timestamp` BIGINT, antes estourava como INT32)
- **Etapa B — EV gates nos motores:** backrun competitor-aware (gas war) + liquidator **ciente de OEV**
  (aplica "OEV haircut" por protocolo e **prioriza Morpho**)
- **Etapa C — thresholds adaptativos:** FEITO, **opt-in** (`ADAPTIVE_THRESHOLDS_ENABLED=false` default → só loga o que faria)
- **Etapa D — Grafana:** parcial/quase — `DimensionMetricsExporter` (DuckDB→Prometheus) + 3 dashboards prontos (meta era 8)
- **OIE completa:** todos os sinais (market-bribe, perfis de competidor, reconciliação de PnL, falhas
  categorizadas, sybil, dedup, latência) caem no ledger DuckDB + Prometheus + painéis Grafana; market-bribe alimenta o BribeCalculator
- **DRY_RUN ledger:** detector + MIS gravam observações no DuckDB (`arb_observed` / `mis_observed`)
- Helpers: `resolveIntelligenceDbPath` / `buildObservationEvent` / `queryTopOpportunityPairs` /
  `attachAndRankPairs` (unificação cross-motor via ATTACH — DuckDB single-writer)
- **Deploy Fly.io:** `Dockerfile` raiz + `deploy/fly/*.toml` com volume persistente

**Achado estratégico (refs):** liquidação na Base se fechando por OEV capture (Aave SVR ~85%,
Moonwell MEV tax ~99%). **Morpho Blue ABERTO = único edge real** → liquidator prioriza Morpho.
Nota competitiva honesta: **~7,5 como software, ~4,5 como competidor** hoje.

- **Total**: contratos **78/79 unit Foundry** (1 skip) + fork verde · **~404 testes TS** (vitest; execution-utils
  **336/336**) · **typecheck 13/13** · 7 apps · 6 packages

### 🟡 Em andamento (próxima sessão)
- **2 semanas DRY_RUN mainnet** — observação + calibração (ledger DuckDB coletando, lucro real US$ 0)
- **OIE Etapa D** — parcial/quase: `DimensionMetricsExporter` (bridge DuckDB→Prometheus) + 3 dashboards
  (operations/performance/rankings) prontos; meta original era 8 dashboards
- **Detector ranking na descoberta** (radar passivo, baixa prioridade)

**Detalhes da adoção OIE em [docs/OIE_PROGRESS.md](./docs/OIE_PROGRESS.md).**

### ✅ Concluído recente (era "em andamento")
- **Sprint 3 Morpho pipeline TS** — FEITO (discovery + calculator + builder + simulator)
- **Motor 2 (MIS)** — virou **motor de execução cross-DEX** (`arbDispatcher`/`arbOpportunity`/config zod),
  **execução OFF por default** (`ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun` → continua gravando `mis_observed`);
  + **detecção triangular** (`findTriangularCycles`, read-only por ora) + inteligência espelhada (EventBus/PnL/competitor/market-bribe)
- **Motor 3 (Backrun)** — fechou as 2 últimas pontas (PnlAggregator + CalibrationDriftTracker + post-mortem
  CompetitorResolver/BlockPositionTracker); **continua BLOQUEADO em prod** (feed de mempool é placeholder; ver acima)
- **OIE Etapa C (thresholds adaptativos)** — FEITO, **opt-in** (`ADAPTIVE_THRESHOLDS_ENABLED=false` default → só loga o que faria)
- **Fios soltos remediados (auditoria):** RPC fallback (dRPC→Alchemy via viem), discovery Aave/Seamless on-chain
  SEMPRE (TheGraph só acelerador), qualidade de dado (gás nunca mais $0, mis-scanner com zod, priority fee real,
  Moonwell `optionalAddress`, INT32 round), classes "órfãs" ligadas (dormentes em DRY_RUN). Deferidos (infra):
  mempool do Motor 3 + `deploy/fly/backrun-engine.toml`
- _Seletor de flashloan 0% (Morpho/Balancer) agora ligado no **liquidator + arb (Motor 2)**; o backrun ainda
  força Aave 0,05% (semi-ligado, sem impacto hoje porque Motor 3 está morto). Regra `approvedDexAdapters`
  documentada não tem enforcement on-chain. Ver_ [docs/LOOSE_WIRES.md](./docs/LOOSE_WIRES.md)._
- **Bribe Compound/Morpho** — variantes WithBribe voltaram no contrato v8 (split); ABI off-chain + builders
  ligados (opt-in `BRIBE_ENABLED=false` default)
- **Health endpoint HTTP** — FEITO (`execution-utils/health`) + Prometheus exporter; backrun passou a expor `/metrics`

### 📅 Roadmap
- **Arb-engine (Motor 2)** — motor de execução JÁ existe (OFF por default); calibrar no DRY_RUN e ligar quando edge provado
- **Execução triangular** — detecção já roda read-only; próximo passo é o caminho de execução
- **Fase 7**: Deploy contratos em Base mainnet + 4 semanas observação capital pequeno
- **Avalanche expansion**: Aave V3 only, +500-800 borrowers
- **Audit externo**: Trail of Bits / Spearbit quando capital > $50k

**Tese de 3 motores descorrelacionados:** ZEUS fatura em qualquer mercado (#1 crash, #2 volume, #3 volatilidade).

**Detalhes completos em [TODO.md](./TODO.md).**

### 🔑 Decisões já tomadas
- Provider RPC: **Alchemy** primário (archive no free) + fallback a definir (dRPC free descartado em 2026-06-23 — não forka archive)
- Owner = **carteira testnet dedicada** `0xE060821b253ec9dad4BDe139c5661Bc07A6AcBB4` (testnet-only)
- Contratos ainda na **SEPOLIA (testnet)** — **NÃO mainnet**. Lucro real **US$ 0** (provado em fork).
  - **Base Sepolia v8 (redeploy 2026-06-23, com DexType.PancakeV3 + adapters DEX):**
    BribeManager `0xe0B6A6840d1f011F27Ec63eb3390D0d7E0904795` · ZeusLiquidator `0x8E769a56F0f3fA7e7410fE5955D94E9dE458193D` ·
    ZeusArbExecutor `0x0156Aa6729891103Cc22b1e14c5E1e5338E6ab4A` · ZeusMoonwellLiquidator `0x3A34EcDD1A9a53d5799fF0f4cB479FF2963F3dA3`.
    Owner = deployer `0xE060…cBB4`. Liquidator + ArbExecutor já com `revive()` (isKilled=false); falta `setOperator(<bot>)` + revive do Moonwell.
  - _Histórico v6 (pré-split, contrato único): Base Sepolia `0xe38298B4d242d0D1C45696a96c4C588926Cf1139`,
    Arb/OP Sepolia `0xe48473D75805886Ac4162B1304EAB6b8F93C5faa`. Anteriores arquivados: Base v2
    `0xe53cb8c...`, Arb/OP v1 `0xd7e8fde...`._

### ⏸️ Aguardando decisão do Humberto
- **Ligar execução do arb (Motor 2)** — motor pronto e OFF por default; aguarda edge provado no DRY_RUN/ledger
- Multisig provider — antes de Fase 7
- Capital inicial concreto — antes de Fase 7
- Audit provider — antes de audit externo

---

## 🔑 Decisões já tomadas

- ✅ Chain inicial: **Base** (Coinbase L2)
- ✅ 3 motores: Liquidations (M1) + MIS scanner (M2) + Backrun (M3); arb Cross-DEX/Triangular compartilha o executor
- ✅ Stack: TypeScript + viem + Foundry (não ethers, não Hardhat)
- ✅ Flashloan: multi-fonte 0% — Morpho + Balancer primário, Aave V3 0.05% fallback
- ✅ Custódia: self-custody com circuit breakers
- ✅ Owner: multisig Safe Wallet em prod
- ✅ Sem proxy upgradeable
- ✅ Repo: `github.com/Opresida/zeus-evm` (push quando MVP estiver pronto)
- ✅ Capital inicial: **decidir depois** (código abstrai)
- ✅ Audit interno antes de mainnet, audit externo antes de capital alto

---

## 🤖 Padrão de trabalho

- **Mapear o que existe ANTES de criar do zero** — sempre buscar reutilizar adapters
- **Em decisão importante, perguntar** via `AskUserQuestion` com tradeoffs
- **Atualizar `TODO.md` ao concluir/iniciar fase**
- **`pnpm typecheck && forge test` antes de "concluído"**
- **Em dúvida sobre math (slippage, fee calc)**, perguntar ao Humberto
- **Commits descritivos em PT-BR**, Conventional Commits opcional

---

## 🔧 Comandos úteis

```bash
# Monorepo
pnpm install
pnpm typecheck
pnpm build
pnpm -r --filter @zeus-evm/detector dev  # subir 1 app

# Foundry (de dentro de contracts/)
forge build
forge test -vvv
forge test --fuzz-runs 100000
forge coverage --report lcov
forge fmt
forge install <repo>
forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast

# Deploy
pnpm --filter @zeus-evm/detector run dev  # detector em watch mode
```

### RTK (Rust Token Killer) — economia de tokens

Humberto usa `rtk` como prefixo padrão:
- `rtk pnpm install` → 90% menos output
- `rtk forge build` (se RTK suportar) ou prefixar comandos verbose
- `rtk git status`, `rtk grep`, `rtk ls`

Se RTK não estiver instalado nesta máquina, comandos normais.

---

## 🧠 Como expandir conhecimento da IA

Eu, Claude, tenho limites em áreas como:
- 🟡 Aerodrome deep mechanics (ve(3,3))
- 🟡 Compound V3 e Morpho APIs específicas
- 🟡 MEV em Base (landscape único)
- 🔴 Gas optimization extremo (Yul/assembly nível Seaport)

**Pra expandir:** Humberto pode salvar MDs em `docs/refs/`. Quando eu trabalhar em área relevante, leio antes de codar. Ver [CONTRACTS.md](./CONTRACTS.md#knowledge-limits-da-ia-claude) seção "Knowledge Limits" pra detalhes.

---

## 📂 Documentação relacionada

| Arquivo | Quando consultar |
|---|---|
| `README.md` | Setup inicial, comandos, roadmap resumido |
| `CONTEXT.md` | Regras, princípios de risco, voz |
| `PROJECT_CONTEXT.md` | Status atual, decisões abertas, time |
| `ARCHITECTURE.md` | Fluxos de dados, estrutura de pastas, schema |
| `TODO.md` | O que falta por fase |
| `CONTRACTS.md` | Spec dos smart contracts + audit pipeline + limites IA |
| `CLAUDE.md` | Este arquivo — contexto portátil |
| `frontend/HANDOFF.md` | **ZEUS Command (frontend Next.js/Vercel)** — intenção, ponte de dados, o que falta, e contexto pro Claude no Antigravity continuar |

**docs/ (status + planos):**

| Arquivo | Quando consultar |
|---|---|
| `docs/OIE_PROGRESS.md` | Adoção da camada OIE (Etapas A→D) + decisões |
| `docs/FIRST_FLIGHT.md` | Primeiro voo / checklist de DRY_RUN |
| `docs/INFRA_EVOLUTION.md` | Evolução de infra |
| `docs/MOTOR3_REFIT.md` | Refit do motor 3 (backrun) |
| `docs/NO_EDGE_TOKENS.md` | Tokens sem edge (blacklist/filtro) |

**docs/refs/ (conhecimento externo — outro agente cuida, não editar aqui):**

| Arquivo | Quando consultar |
|---|---|
| `docs/refs/competitive-landscape.md` | Landscape competitivo MEV/liquidações na Base |
| `docs/refs/cross-dex-arb-status.md` | Status do arb cross-DEX |
| `docs/refs/engine-strategy.md` | Estratégia dos 3 motores |
| `docs/refs/fly-deploy.md` | Guia de deploy Fly.io |
| `docs/refs/infra-costs.md` | Custos de infra |
| `docs/refs/morpho-profit-projection.md` | Projeção de lucro Morpho (edge real) |

Quando voltar ao projeto em outra sessão/máquina, ler os 7 arquivos-raiz + `docs/OIE_PROGRESS.md` é suficiente.
