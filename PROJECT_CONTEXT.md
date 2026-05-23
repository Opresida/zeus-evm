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

## 📊 Status atual

### ✅ Concluído (2026-05-22)

**Fases 0 → 3 + Track A (deploy Sepolia) + Track B (backtest + fork tests positivos)**

- **Fase 0** — Monorepo pnpm + Foundry + 7 docs canônicos + repo GitHub
- **Fase 1** — `ZeusExecutor.sol` (280 LOCs) + UniV3Lib + AerodromeLib + 18 unit tests
- **Fase 2** — Detector DRY_RUN funcional: chain-config (Base + Sepolia), dex-adapters (UniV3+Aerodrome), opportunities, WSS subscribe
- **Fase 3** — Flashloan Aave V3 + TxBuilder + Simulator (eth_call) + 5 fork tests flashloan
- **Track A** — ZeusExecutor deployado em Base Sepolia: [`0xe48473...`](https://sepolia.basescan.org/address/0xe48473d75805886ac4162b1304eab6b8f93c5faa), verified
- **Track B** — Refactor `packages/strategy` + `apps/backtest` + fork tests positivos (wallet + flashloan arb lucrativa)
- **Total**: **29/29 testes Foundry passando** · 6/6 vitest · 5/5 typecheck workspaces · push contínuo no GitHub

### 🔍 Descoberta importante (Fase 4a)

Backtest de 1000 blocos amostrados (~5.5h Base mainnet) com os 5 pares blue-chip da config: **0 oportunidades cross-DEX detectadas**. Confirma que Base mainnet em 2026 é hyper-competitivo pra arb em pares populares (MEV bots dominam). **Cross-DEX nesses pares não tem edge sistemática.**

### 🎯 Em andamento (Fase 4c — decidido 2026-05-23)

**Mix A+B em duas trilhas independentes:**
- **Trilha 1 (Liquidações Aave V3)** — motor de edge previsível, 5-10% por liquidação
- **Trilha 2 (Radar Longtail/Medium-cap)** — captura spreads esporádicos em pools com menos competição

**Princípio:** construir e validar cada trilha **isoladamente em fork mainnet** antes de rodarem juntas. Sem cross-contamination de risco.

**Estratégias futuras mapeadas (Fase 9+):**
- Pools RWA + LSTs (bots institucionais ignoram, spreads grandes)
- Backrunning de baleias (dislocation pós-trade, jogo de RPC latency)
- Arbitragem ve(3,3) intra-Aerodrome (stable vs volatile pool do mesmo par)

### ❌ Pendente
Lista priorizada em [TODO.md](./TODO.md). Próximas grandes etapas:

| Fase | Entrega | Status |
|---|---|---|
| 0-3 | Setup + contratos + detector + flashloan | ✅ Pronto |
| 4a | Backtest histórico | ✅ Pronto (0 opp em blue chips) |
| 4b | Fork tests positivos (wallet+flashloan) | ✅ Pronto (29/29) |
| 4c | **Decidir estratégia com edge real** | 🟡 Decisão aberta |
| 5a | Deploy testnet Sepolia | ✅ Pronto |
| 5b | 2 semanas observação testnet | ⏳ Aguardando 4c |
| 6 | Liquidations | ⏳ Aguardando 4c |
| 7 | Deploy mainnet capital pequeno + 4 semanas | ❌ |
| 8 | Audit externo Certik (~$4.2k) | ❌ |
| 9 | Scale (capital + multi-chain) | ❌ |

---

## 🔑 Decisões já tomadas

- ✅ Chain inicial: **Base**
- ✅ Estratégias planejadas: Cross-DEX (validado: sem edge em blue chips), Triangular, **Liquidations** (próximo foco)
- ✅ Repo: `github.com/Opresida/zeus-evm` (push contínuo desde Fase 1)
- ✅ Capital inicial: **decidir depois** (código abstrai)
- ✅ Stack: TypeScript + viem + Foundry
- ✅ Flashloan provider: Aave V3 (validado em fork mainnet, mecânica 100%)
- ✅ Custódia: self-custody com circuit breakers no contrato
- ✅ Owner do contrato será multisig (Safe Wallet em Base) em prod
- ✅ Provider RPC: **dRPC** (210M CU/mês free) primário + Alchemy fallback
- ✅ Carteira testnet dedicada: `0xE060821b253ec9dad4BDe139c5661Bc07A6AcBB4` (testnet-only)
- ✅ Contrato testnet: `0xe48473d75805886ac4162b1304eab6b8f93c5faa` (Base Sepolia, verified)

## 🤔 Decisões abertas

- ❓ **Estratégia com edge real** (Fase 4c): liquidations (recomendada) / longtail / triangular
- ❓ Multisig provider: Safe Wallet (padrão) vs alternativa — antes de Fase 7
- ❓ Como armazenar histórico de trades: Neon Postgres futuro ou só logs?
- ❓ Audit externo: Certik (~$4.2k) vs Spearbit (~$10k) vs Trail of Bits ($15k+) — antes de Fase 8

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
