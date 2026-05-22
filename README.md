# ZEUS EVM — Arbitragem on-chain

<p align="center">
  <strong>Bot de arbitragem em EVM (Base inicial). Capital próprio + Flashloan.</strong><br>
  <em>100% DEX. Self-custody. Atômico ou nada.</em>
</p>

**Chain inicial:** Base (Coinbase L2)
**Próximas chains:** Arbitrum One, Optimism, BSC (após estratégia validada)
**Time:** Humberto (product) + Claude (engineering)
**Status:** Fases 0-3 + Track A (deploy Sepolia) + Track B (backtest + fork tests positivos) concluídas — **29/29 testes Foundry passando** · contrato verified em Base Sepolia: [`0xe48473...`](https://sepolia.basescan.org/address/0xe48473d75805886ac4162b1304eab6b8f93c5faa)

---

## 🎯 O que é

Bot de arbitragem on-chain em EVM, com **duas modalidades operacionais coexistindo no mesmo executor:**

1. **Modalidade Capital Próprio (wallet-arb)** — bot envia seus próprios tokens, multi-swap atômico via DEXs, lucro vai pra wallet do operador. Mais simples, capital limita o tamanho.

2. **Modalidade Flashloan (flashloan-arb)** — borrow via Aave V3 → multi-swap → repay tudo em **1 tx atômica**. Capital ilimitado (até liquidez do lender). Tx reverte se profit < custo.

**Três estratégias em paralelo dentro desse codebase:**
- **Cross-DEX arb** em pares medium-cap (foco principal)
- **Triangular intra-DEX** explorando ineficiências em pools com fee tiers (Uniswap V3 0.05/0.3/1%)
- **Liquidations** em Aave V3 / Compound III / Morpho (usa flashloan pra capturar bonus 5-10%)

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
│   ├── detector/                      # TS — main loop + scan + simulate
│   ├── backtest/                      # TS — replay histórico de blocos
│   └── monitor/                       # placeholder (Fase 6: liquidations)
│
├── packages/
│   ├── chain-config/                  # BASE_MAINNET + BASE_SEPOLIA + pairs
│   ├── dex-adapters/                  # quoteUniswapV3 + quoteAerodrome
│   ├── strategy/                      # opportunities + executor utils
│   └── shared-types/
│
└── docs/refs/                         # MDs externos pra expandir IA
```

---

## 🗺️ Roadmap (resumo)

Detalhes em [TODO.md](./TODO.md).

| Fase | Entrega | Status |
|---|---|---|
| **0** | Setup inicial (monorepo + Foundry + docs canônicos) | ✅ Pronto |
| **1** | ZeusExecutor.sol + UniV3Lib + AerodromeLib + 18 unit tests | ✅ Pronto |
| **2** | Detector DRY_RUN: chain-config + dex-adapters + opportunities + WSS | ✅ Pronto |
| **3** | Flashloan Aave V3 + TxBuilder + Simulator + 5 fork tests | ✅ Pronto |
| **4a** | Backtest histórico — confirmou: cross-DEX em blue chips sem edge | ✅ Pronto |
| **4b** | Fork tests positivos (wallet + flashloan arb lucrativa) | ✅ Pronto |
| **4c** | **Decidir estratégia com edge real** (liquidations recomendada) | 🟡 Decisão |
| **5a** | Deploy ZeusExecutor em Base Sepolia + verified Basescan | ✅ Pronto |
| **5b** | 2 semanas observação testnet | ⏳ Aguarda 4c |
| **6** | Liquidations (Aave V3 + Compound III + Morpho) | ❌ Pendente |
| **7** | Deploy mainnet capital pequeno + 4 semanas observação | ❌ Pendente |
| **8** | Audit externo (Certik ~$4.2k ou similar) | ❌ Pendente |
| **9** | Scale: capital aumentado, multi-chain (Arbitrum + Optimism) | ❌ Pendente |

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
