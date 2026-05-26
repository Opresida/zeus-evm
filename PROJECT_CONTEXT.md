# PROJECT_CONTEXT — ZEUS EVM

Visão consolidada do projeto. Atualizado a cada fase aprovada.

---

## 🎯 O que é

**ZEUS EVM** é um bot de arbitragem on-chain em EVM com **duas modalidades operacionais** (capital próprio e flashloan) e **três estratégias** (cross-DEX, triangular, liquidations) coexistindo no mesmo codebase.

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

## 📊 Status atual (snapshot 2026-05-26)

### ✅ Concluído

**Fases 0-5a + Trilha 1 + Sprint 1 + Sprint 2 + Security Audit Pass 1+2 + Liquidator MVP**

- **Fases 0-3** — Monorepo + ZeusExecutor + Detector DRY_RUN + Flashloan Aave V3 (ver TODO.md histórico)
- **Track A+B** — Deploy testnet + cross-DEX validado sem edge (declarado dead-end)
- **Trilha 1 (Liquidações Aave V3)** — executeLiquidation() + 4 fork tests · **$8.643 profit em fork test mainnet**
- **Sprint 1 (Aave V3 multi-chain)** — 3 chains testnet (Base/Arb/OP Sepolia) armed via revive+setOperator
- **Sprint 3 Morpho (parcial)** — schema-fix do subgraph (Messari-format), 200 positions ativas reais detectadas em Base mainnet · contrato `executeMorphoLiquidation` pronto
- **Redeploy v6 evolutivo** (2026-05-25) — 3 chains testnet com Aave + Compound + Morpho:
  - Base Sepolia: [`0xe38298B4...`](https://sepolia.basescan.org/address/0xe38298B4d242d0D1C45696a96c4C588926Cf1139)
  - Arbitrum Sepolia: [`0xe48473D7...`](https://sepolia.arbiscan.io/address/0xe48473D75805886Ac4162B1304EAB6b8F93C5faa)
  - Optimism Sepolia: [`0xe48473D7...`](https://sepolia-optimism.etherscan.io/address/0xe48473D75805886Ac4162B1304EAB6b8F93C5faa)
- **Security Audit Pass 1 + Pass 2** (2026-05-25) — `ZeusExecutor.sol` revisado sob lente AppSec (Jim Manico) + vuln assessment (Omar Santos). Identificados **2 HIGH + 4 MEDIUM**. Todos **CORRIGIDOS**: H-01 approval Morpho bounded+reset, H-02 maxTradePerToken map, M-01 pre-existing balance snapshot, M-02 flashloanAmount explícito Morpho. 11 testes adversariais novos
- **Liquidator MVP** (`apps/liquidator/` — 2026-05-25):
  - Sprint 1 Aave V3 pipeline completo (calculator binary search + simulator + builder + dispatcher 3 modos)
  - Sprint 2 Compound III pipeline (5+8 collaterals cacheados Base mainnet, event scan chunked, quoteCollateral on-chain)
  - Discovery automática Aave V3: subgraph → Multicall3 HF → resolve par dominante (live: 29 at-risk Base mainnet)
  - Event decoder pós-tx + log humanizado `💰 $12.45 (gas $0.32, líquido $12.13)` + calibração delta real-vs-esperado
  - Slippage cache TTL 60s
  - 3 modos operacionais: `dryrun` / `testnet` / `mainnet`
- **Backend completo — 6 gaps críticos** (`apps/liquidator/` — 2026-05-26):
  - **Gap #1 Daily loss limit** — `pnlTracker.ts` rolling 24h JSONL + auto kill switch on-chain
  - **Gap #2 Cooldown após N falhas** — `failureTracker.ts` 3 falhas seguidas → 5min cooldown
  - **Gap #3 Position deduplication** — `positionDedup.ts` pending/confirmed/failed + TTL
  - **Gap #4 Gas reserve monitoring** — `gasReserveTracker.ts` 2 thresholds + anti-spam
  - **Gap #5 EIP-1559 gas pricing** — `gasOracle.ts` baseFee × multiplier + cache por bloco
  - **Gap #7 Event bus + alerting** — `eventBus.ts` + Discord/Generic webhook sinks (arquitetura prepara WebSocket pro futuro mobile app)
  - **Gap #8 Stale position re-check** — `staleCheck.ts` re-checa HF on-chain antes do submit
  - Pipeline integrado: 5 gates pre-dispatch + EIP-1559 + tracking de wins/losses + auto kill switch + alertas externos
- **Shared package `@zeus-evm/aave-discovery`** — reusável entre apps (logger injetável, ABIs canônicas, reserves cache, discovery completa)
- **Total**: **53/53 testes Foundry** · 6/6 vitest · **9/9 typecheck workspaces** (incluindo packages/aave-discovery + apps/liquidator)

### 🔍 Aprendizados consolidados

- **Cross-DEX em Base 2026 não tem edge** (backtest 0/1000 blocos) — radar passivo apenas
- **Long tail $5-100 de liquidações = nicho viável** — bots top ignoram (infra cara não cobre)
- **Princípio "validar antes de escalar"** continua sendo bússola — testnet 2 sem → mainnet capital pequeno → audit → scale

### 🎯 Em andamento

**Sprint 3 Morpho pipeline TS** — discovery (com IRM enrichment on-chain) + calculator + builder + simulator pra `executeMorphoLiquidation`. Estimativa ~2 dias próxima sessão.

**2 semanas DRY_RUN mainnet** — assim que Sprint 3 estiver pronto, rodar monitor + liquidator em Base mainnet em modo `dryrun` pra calibração de thresholds + slippage.

**Health endpoint HTTP** — adiado até decisão de infra (Fly.io / outra). Sem orquestrador externo não tem valor agora.

### 🔒 Backend readiness pra mainnet

Backend está em **estado pronto pra primeira tx real** assim que: (1) Sprint 3 Morpho concluir; (2) Deploy ZeusExecutor em Base mainnet; (3) 2 semanas DRY_RUN calibrar. 6 gaps críticos resolvidos garantem operação segura:
- Kill switch automático (PnL > limit)
- Cooldown após cascata de erros
- Sem re-submit em race condition (dedup)
- Sem dispatch sem ETH (gas reserve)
- Pricing EIP-1559 correto pra Base/Arb/OP
- Alertas externos via Discord webhook
- Stale check elimina race contra outros bots

### 📅 Roadmap futuro (decisões consolidadas 2026-05-25)

**Tese de 3 motores descorrelacionados:**
- Motor #1 Liquidations (atual): ganha em CRASH
- Motor #2 JIT Liquidity (Sprint 4): ganha em VOLUME
- Motor #3 Backrun dislocation (Sprint 5): ganha em VOLATILIDADE

| Fase / Sprint | Entrega | Status |
|---|---|---|
| Sprint 3 Morpho pipeline TS | Cobertura completa nos 3 protocolos | 🟡 Em andamento |
| Fase 5b — 2 semanas DRY_RUN mainnet | Calibração com dados reais | ⏳ Após Sprint 3 |
| Fase 7 — Mainnet capital pequeno | Deploy executor Base mainnet + cap $1500 | ❌ Após 5b |
| Sprint 4 — JIT Liquidity | Motor #2, requer Alchemy Mempool ($199/mês) | ❌ Após receita real |
| Sprint 5 — Backrun dislocation | Motor #3, reusa mempool | ❌ Após Sprint 4 |
| Avalanche expansion | Aave V3 only, +500-800 borrowers | ❌ Após Morpho |
| Polygon expansion | Aave V3 only, MAS mercado saturado | ❌ Baixa prioridade |
| Fase 8 — Audit externo | Trail of Bits / Spearbit quando capital > $50k | ❌ Pós-receita |

---

## 🔑 Decisões já tomadas

- ✅ Chain inicial: **Base** (próximas: Avalanche → Polygon)
- ✅ Estratégia atual: **Liquidations** em 3 protocolos (Aave V3 + Compound III + Morpho Blue)
- ✅ Estratégias futuras: **3 motores descorrelacionados** (Liquidations + JIT Liquidity + Backrun dislocation)
- ✅ Princípio inviolável: **FLASHLOAN-ONLY** até primeiro lucro real ([[project-zeus-evm-capital-principle]])
- ✅ Cross-DEX: dead-end confirmado em Base 2026 (radar passivo)
- ✅ Repo: `github.com/Opresida/zeus-evm`
- ✅ Stack: TypeScript + viem + Foundry (Solidity 0.8.27 + via_ir + 1M optimizer runs)
- ✅ Flashloan provider: Aave V3 universal (0.05% fee)
- ✅ Owner em prod: multisig Safe Wallet
- ✅ Provider RPC dev: dRPC free tier; prod: Alchemy Growth ($49/mês)
- ✅ Carteira testnet dedicada: `0xE060821b253ec9dad4BDe139c5661Bc07A6AcBB4`
- ✅ Contratos testnet v6 (Aave + Compound + Morpho): ver tabela em "Concluído" acima
- ✅ Audit externo recomendado: Trail of Bits / Spearbit (NÃO Certik) — quando capital > $50k
- ✅ Audit interno (Pass 1 + Pass 2) substitui Certik provisoriamente (decisão Humberto 2026-05-25)

## 🤔 Decisões abertas

- ❓ Multisig provider concreto: Safe Wallet (padrão) vs alternativa — antes de Fase 7
- ❓ Histórico de trades: Neon Postgres futuro ou logs persistidos em Fly.io?
- ❓ Sequencer Base — quando justificar mempool premium ($199-499/mês) — gatilho: receita > $1k/mês

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
