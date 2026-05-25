# ZEUS EVM — Arbitragem on-chain

<p align="center">
  <strong>Bot de arbitragem em EVM (Base inicial). Capital próprio + Flashloan.</strong><br>
  <em>100% DEX. Self-custody. Atômico ou nada.</em>
</p>

**Chain inicial:** Base (Coinbase L2)
**Próximas chains:** Avalanche (após validação), Polygon (avaliar), BSC (longo prazo)
**Time:** Humberto (product) + Claude (engineering)
**Status (snapshot 2026-05-25):** **3 protocolos integrados** (Aave V3 + Compound III + Morpho Blue) · **Sprint 1 + Sprint 2 do liquidator entregues** · **Security Audit Pass 2 com 4 fixes aplicados** · **53/53 testes Foundry** · **9/9 typecheck workspaces** · contratos v6 verified em 3 testnets:
- Base Sepolia v6: [`0xe38298B4...`](https://sepolia.basescan.org/address/0xe38298B4d242d0D1C45696a96c4C588926Cf1139)
- Arbitrum Sepolia v6: [`0xe48473D7...`](https://sepolia.arbiscan.io/address/0xe48473D75805886Ac4162B1304EAB6b8F93C5faa)
- Optimism Sepolia v6: [`0xe48473D7...`](https://sepolia-optimism.etherscan.io/address/0xe48473D75805886Ac4162B1304EAB6b8F93C5faa)

---

## 🎯 O que é

Bot de arbitragem on-chain em EVM, com **duas modalidades operacionais coexistindo no mesmo executor:**

1. **Modalidade Capital Próprio (wallet-arb)** — bot envia seus próprios tokens, multi-swap atômico via DEXs, lucro vai pra wallet do operador. Mais simples, capital limita o tamanho.

2. **Modalidade Flashloan (flashloan-arb)** — borrow via Aave V3 → multi-swap → repay tudo em **1 tx atômica**. Capital ilimitado (até liquidez do lender). Tx reverte se profit < custo.

**Estratégia atual: Liquidations em 3 protocolos** (Aave V3 / Compound III / Morpho Blue) via flashloan, capturando bonus de 5-10%.

**Estratégias futuras (planejadas como 3 motores descorrelacionados):**
- **Motor #1 — Liquidations** (atual): ganha em crashes
- **Motor #2 — JIT Liquidity UniV3** (Sprint 4): ganha em alto volume DEX
- **Motor #3 — Backrun dislocation** (Sprint 5): ganha em volatilidade súbita

**Cross-DEX arbitrage** foi testada (1000 blocos backtest Base mainnet) e **declarada dead-end** — MEV bots top dominam em <100ms. Mantida como radar passivo.

---

## ⚠️ Realidade do mercado

**Arb steady-state cross-DEX pra blue chips em mainnet não existe** — bots top (Wintermute, Jaredfromsubway, Jump) capturam tudo em <1 bloco. Mesmo princípio aplicado a EVM, talvez mais intenso que Solana.

**Onde mora edge real:**
- L2s onde competição é menor (escolhemos Base)
- Tokens medium-cap (fora top 10)
- Dislocation transitória pós-trade grande (100ms-3s)
- Liquidações em momentos de volatilidade

Não vamos ficar ricos arbitrando ETH/USDC entre Uniswap e Sushi. Vamos atacar nichos.

---

## 🚀 Como rodar

### Pré-requisitos
- Node.js 22+
- pnpm 10+ (monorepo é pnpm-only)
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, cast, anvil)
- Chave RPC Base (Alchemy/Infura) — ver `.env.example`

### Setup

```bash
# Instalar deps (pnpm-only, npm é bloqueado por preinstall hook)
pnpm install

# Instalar libs Foundry (1ª vez)
cd contracts
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
cd ..

# Build contratos
pnpm contracts:build

# Testes (unit + fork mainnet)
BASE_RPC_HTTP=$BASE_RPC_HTTP pnpm contracts:test

# Typecheck
pnpm typecheck

# Smoke test detector (valida config + RPC + saldo)
pnpm --filter @zeus-evm/detector exec tsx src/smoke.ts

# Detector off-chain DRY_RUN (não submete tx)
pnpm --filter @zeus-evm/detector start

# Backtest histórico (replay de N blocos)
NUM_BLOCKS=1000 STEP=10 pnpm --filter @zeus-evm/backtest start
```

### Variáveis de ambiente

Copie `.env.example` → `.env` e preencha. Críticas:
- `BASE_RPC_HTTP` — **dRPC** recomendado (210M CU/mês free), Alchemy fallback
- `BASE_RPC_WS` — Alchemy WSS pra subscribe newHeads
- `EXECUTOR_PRIVATE_KEY` — chave **testnet-only** em dev; multisig + hardware wallet em prod
- `EXECUTOR_CONTRACT_ADDRESS` — endereço do ZeusExecutor deployado on-chain
- `EXECUTOR_BOT_ADDRESS` / `EXECUTOR_OWNER_ADDRESS` — EOA do bot + owner do contrato
- `MAX_TRADE_ETH` / `MIN_PROFIT_USD` — circuit breakers
- `KILL_SWITCH=true` (default fail-safe; só `false` em produção deliberada)

---

## 🧱 Stack

| Camada | Tech |
|---|---|
| **Off-chain (detector)** | TypeScript + Node 22 + `viem` |
| **Smart contracts** | Solidity 0.8.27 + Foundry |
| **Otimização** | via_ir + optimizer runs 1M |
| **Provider RPC** | Alchemy (primário) + público (fallback) |
| **Mempool** | Alchemy Subscriptions (ou Blocknative) |
| **Flashloan** | Aave V3 (universal, 0.05% fee) |
| **DEXs Base** | Uniswap V3, Aerodrome, BaseSwap, SushiSwap |
| **Deploy** | Fly.io (igual Zeus Solana) |
| **Monitoring** | Tenderly + Discord webhook + logs estruturados (pino) |

---

## 📁 Estrutura

```
zeus-evm/
├── README.md                          # Este arquivo
├── CONTEXT.md                         # Regras, padrões, voz
├── PROJECT_CONTEXT.md                 # Visão consolidada + status
├── ARCHITECTURE.md                    # Fluxos de dados, decisões
├── TODO.md                            # Pendente detalhado por fase
├── CLAUDE.md                          # Pacote portátil para IA
├── CONTRACTS.md                       # Spec smart contracts + audit pipeline
│
├── pnpm-workspace.yaml + .env.example + .gitignore
│
├── contracts/                         # Foundry project
│   ├── src/
│   │   ├── ZeusExecutor.sol           # Hot path: arb + flashloan
│   │   ├── libraries/                 # UniswapV3Lib, AerodromeLib (inline)
│   │   └── interfaces/                # IZeusExecutor + Aave interfaces
│   ├── test/
│   │   ├── ZeusExecutor.t.sol         # 18 unit tests
│   │   └── fork/                      # 11 fork tests (Base mainnet)
│   ├── script/Deploy.s.sol            # chainId-based deploy
│   └── lib/                           # forge install deps
│
├── apps/
│   ├── detector/                      # TS — cross-DEX scanner DRY_RUN (radar passivo)
│   ├── backtest/                      # TS — replay histórico + discover-pairs
│   ├── monitor/                       # TS — DRY_RUN: discovery 3 protocolos (read-only)
│   └── liquidator/                    # TS — pipeline dispatch: calc → sim → build → dispatch (3 modos)
│       └── src/protocols/{aave,compound}/  # pipelines protocol-specific
│
├── packages/
│   ├── chain-config/                  # BASE + BASE_SEPOLIA + ARBITRUM + OPTIMISM (mainnet + testnet)
│   ├── dex-adapters/                  # quoteUniswapV3 + quoteAerodrome
│   ├── strategy/                      # opportunities + executor utils + ABI
│   ├── aave-discovery/                # NOVO — shared package (ABIs + reserves cache + discovery)
│   └── shared-types/
│
└── docs/refs/                         # MDs externos pra expandir IA
```

---

## 🗺️ Roadmap (resumo)

Detalhes em [TODO.md](./TODO.md).

| Fase / Sprint | Entrega | Status |
|---|---|---|
| **0** | Setup inicial (monorepo + Foundry + docs canônicos) | ✅ |
| **1** | ZeusExecutor.sol + UniV3Lib + AerodromeLib + 18 unit tests | ✅ |
| **2** | Detector DRY_RUN: chain-config + dex-adapters + opportunities + WSS | ✅ |
| **3** | Flashloan Aave V3 + TxBuilder + Simulator + fork tests | ✅ |
| **4a-c** | Backtest cross-DEX (sem edge) + Trilha 1 Liquidations Aave V3 (4 fork tests $8.643 profit) | ✅ |
| **5a** | Deploy ZeusExecutor v2 → v6 evolutivo em 3 chains testnet (Base + Arb + OP) | ✅ |
| **6.5 — Sprint 1** | Aave V3 multi-chain expansion (3 chains armed: revive + setOperator) | ✅ |
| **6.5 — Sprint 2** | Compound III pipeline + executeCompoundLiquidation + 4 fork tests | ✅ |
| **6.5 — Sprint 3** | Morpho Blue contract entregue + subgraph schema-fix · **TS pipeline pendente** | 🟡 |
| **Audit Pass 1+2** | `ZeusExecutor.sol` revisado · 2 HIGH + 4 MEDIUM identificados e corrigidos · 11 testes adversariais | ✅ |
| **Liquidator MVP** | `apps/liquidator` Sprint 1 Aave + Sprint 2 Compound · discovery automática · event decoder · slippage cache · 3 modos | ✅ |
| **5b** | 2 semanas DRY_RUN mainnet observação calibração | ⏳ Próximo |
| **7** | Deploy mainnet capital pequeno (cap baixo) + 4 semanas observação | ❌ Pendente |
| **Sprint 4** | JIT Liquidity (motor #2 descorrelacionado) + Alchemy Mempool API | ❌ Pós-receita |
| **Sprint 5** | Backrun dislocation (motor #3) — reusa mempool | ❌ Pós-Sprint 4 |
| **Avalanche expansion** | Aave V3 only, +500-800 borrowers | ❌ Pós-Morpho |
| **8** | Audit externo Trail of Bits / Spearbit (capital > $50k) | ❌ Pendente |

**Total atual:** 53/53 Foundry tests · 9/9 typecheck workspaces · 3 protocolos · 3 chains testnet armed

---

## 🛡️ Princípios de risco (não-negociáveis)

1. **Atomic-only** — se qualquer step do arb falha, tx inteira reverte. Sem estado intermediário travado.
2. **Self-custody com cap por tx** — bot tem `MAX_TRADE_ETH` cap absoluto. Mesmo se ele "decidir" gastar mais, contrato impede.
3. **Kill switch testado mensalmente** — `KILL_SWITCH=true` para tudo em <1 bloco.
4. **Min profit obrigatório on-chain** — `params.minProfitWei` faz tx reverter se profit < threshold.
5. **Sem reuso de chave de outros projetos** — chave do bot EVM é exclusiva, separada do Zeus Solana.
6. **Capital escalonado** — começa pequeno, aumenta só após drawdown stable.

---

## 👥 Time

- **Humberto** — product, strategy, decisões executivas
- **Claude (Anthropic)** — engineering, implementação, validação

Comunicação: direta, iterativa, PT-BR.

---

## 📜 Licença

Proprietário. Todos os direitos reservados.
