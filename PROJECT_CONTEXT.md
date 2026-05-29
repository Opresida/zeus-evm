# PROJECT_CONTEXT — ZEUS EVM

Visão consolidada do projeto. Atualizado a cada fase aprovada.

---

## 🎯 O que é

**ZEUS EVM** é um bot de MEV on-chain em EVM, **flashloan-first** (Aave V3), com **3 motores descorrelacionados** coexistindo no mesmo codebase: **Liquidations** (Motor 1), **Cross-DEX Arb** (Motor 2, via radar MIS) e **Backrun** (Motor 3).

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

## 📊 Status atual (snapshot 2026-05-29)

### ✅ Concluído

**Camada on-chain (4 contratos v8 split — resolve EIP-170):**
- **BribeManager** (gorjeta MEV) + **ZeusLiquidator** (Aave/Compound/Morpho) + **ZeusArbExecutor** (arb/backrun) + **ZeusMoonwellLiquidator** (Moonwell)
- Audit interno Pass 1-4 + fixes B-1 a B-7. Os 3 primeiros deployados em Base Sepolia; Moonwell entra no próximo deploy (já no Deploy.s.sol).

**Motor 1 — Liquidations (5 protocolos):** Aave V3 · Compound III · Morpho Blue · Seamless (fork Aave) · Moonwell (fork Compound V2). Discovery on-chain (event scan + BorrowerCache acumulativo) + subgraph. Pipeline com gates (kill/cooldown/dedup/gas/stale) + EIP-1559 + caixa-preta (intelligence DuckDB).

**Multi-chain code-ready (Motor 1):** Base · Arbitrum · Optimism · **Polygon** · **Avalanche** — endereços verificados na fonte (aave-address-book, Uniswap sdk-core, LFJ docs).

**Motor 2 — Cross-DEX Arb (radar MIS):** `apps/mis-scanner` — pricing local (UniV3 tick / Aero / Trader Joe LB), varredura em multicall, derivação on-chain de tokens (colaterais dos protocolos), flash estimator via quoter, **sizing ótimo do empréstimo** + gate de profundidade (descarta pool raso). Ranqueia por PERSISTÊNCIA. Observação pura (não submete tx).

**Motor 3 — Backrun:** `apps/backrun-engine` — planner + bribe + bundling (Flashbots/Atlas/Blocknative) + trackers. Esperando feed de mempool premium (placeholder).

**Validação contra mainnet (fork via Alchemy):** **34/34 fork tests verdes**, incluindo prova de LUCRO ponta-a-ponta dos 3 motores (Motor 1 liquidação +$6.157 realista; Motor 2/3 +$300k+ com gap inflado de propósito pra provar a mecânica). Endereços/ABIs/premium flashloan (0.05%) confirmados nas 3 chains via eth_call.

- **Total**: 67 unit + 34 fork (Foundry) · execution-utils 256 · liquidator 22 · mis-scanner 6 · **13/13 typecheck**

### 🔍 Aprendizados consolidados (Doutrina de Edge)

- **Edge NÃO é velocidade** (perdemos pros bots top em blue-chips) — é **cobertura + persistência** em pares sub-servidos (LSDs, stables fragmentadas) e protocolos de nicho (Morpho/Moonwell/Seamless).
- **Cross-DEX repositionado:** não é "dead-end" — é o Motor 2, mirando ineficiência PERSISTENTE (não pico de 1 bloco). O MIS é o radar disso.
- **Lucro real até hoje = US$ 0:** lógica provada (fork), mas não deployado. Oportunidade real exige movimento de mercado + ganhar a corrida + dias de coleta do MIS.

### 🎯 Em andamento / próximos passos

- **Deploy mainnet** dos 4 contratos (técnico) + capital + multisig.
- **2 semanas DRY_RUN** mainnet + dias de coleta do MIS pra persistência emergir.
- **RPC pago + Fly.io** pra rodar MIS/discovery 24/7 (dRPC free serve reads; fork test usa Alchemy).

### 📅 Roadmap futuro

**Tese de 3 motores descorrelacionados:** Motor 1 ganha em CRASH · Motor 2 em VOLUME · Motor 3 em VOLATILIDADE.

| Item | Status |
|---|---|
| 4 contratos + 5 protocolos + multi-chain code-ready | ✅ |
| Motor 2 radar MIS + Trader Joe LB (Avalanche) | ✅ |
| Motor 3 backrun engine | ✅ código |
| Fork tests de lucro dos 3 motores (Alchemy) | ✅ 34/34 |
| Deploy mainnet (4 contratos) + capital + multisig | ❌ |
| 2 semanas DRY_RUN + coleta MIS | ❌ |
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
