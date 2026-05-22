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

**Fase 0 — Setup**
- Repo `zeus-evm` criado em `C:\Users\user\zeus-evm` (local, sem push GitHub ainda)
- Monorepo pnpm com workspaces (`apps/`, `packages/`, `contracts/`)
- Foundry inicializado com `foundry.toml` (solc 0.8.27, via_ir, optimizer 1M runs)
- Stub do contrato `ZeusExecutor.sol` com structs `SwapStep`, `ArbitrageParams`, interface `IZeusExecutor`, custom errors, eventos
- Stub de teste `ZeusExecutor.t.sol` pronto pra forks
- 7 docs canônicos criados: README, CONTEXT, PROJECT_CONTEXT, ARCHITECTURE, TODO, CLAUDE, CONTRACTS
- `.env.example` com 20+ variáveis documentadas
- `.gitignore` configurado pra Node + Foundry

### 🟡 Em andamento
- Setup completo do detector TS e chain-config

### ❌ Pendente
Lista priorizada em [TODO.md](./TODO.md). Próximas grandes etapas:

| Fase | Entrega | Estimativa |
|---|---|---|
| 1 | ZeusExecutor.sol completo + adapters Uniswap V3 + Aerodrome | 3-4 dias |
| 2 | Detector TS (mempool listener + opportunity calc) | 4-5 dias |
| 3 | Flashloan Aave V3 integration | 2-3 dias |
| 4 | Backtest com fork Base mainnet | 2-3 dias |
| 5 | Deploy Base Sepolia + 2 semanas simulação | 2 semanas |
| 6 | Liquidations | 1 semana |
| 7 | Deploy mainnet capital pequeno + 2-4 semanas observação | 1 mês corrido |
| 8 | Audit externo (Certik ou similar) | 1-2 semanas |
| 9 | Scale (capital + multi-chain) | indefinido |

---

## 🔑 Decisões já tomadas

- ✅ Chain inicial: **Base**
- ✅ Estratégias prioritárias: **Cross-DEX medium-cap + Triangular intra-DEX + Liquidations**
- ✅ Repo separado em `github.com/Opresida/zeus-evm` (push quando MVP estiver pronto)
- ✅ Capital inicial: **decidir depois** (código abstrai)
- ✅ Stack: TypeScript + viem + Foundry
- ✅ Flashloan provider: Aave V3 (padrão), Balancer como secundário
- ✅ Custódia: self-custody com circuit breakers no contrato
- ✅ Owner do contrato será multisig (Safe Wallet em Base)

## 🤔 Decisões abertas

- ❓ Multisig provider: Safe Wallet (padrão) vs alternativa
- ❓ Mempool monitoring: Alchemy Subscriptions vs Blocknative vs Reth self-hosted
- ❓ Como armazenar histórico de trades: Neon Postgres futuro ou só logs?
- ❓ Quando fazer push pra GitHub (push agora vs esperar MVP)
- ❓ Audit externo: Certik (R$ 25k) vs Trail of Bits (R$ 60k+) vs OpenZeppelin Defender

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
