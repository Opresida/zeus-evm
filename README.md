# ZEUS EVM — Arbitragem on-chain

<p align="center">
  <strong>Bot de arbitragem em EVM (Base inicial). Capital próprio + Flashloan.</strong><br>
  <em>100% DEX. Self-custody. Atômico ou nada.</em>
</p>

**Chain inicial:** Base (Coinbase L2)
**Próximas chains:** Arbitrum One, Optimism, BSC (após estratégia validada)
**Time:** Humberto (product) + Claude (engineering)

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
# Instalar deps
pnpm install

# Instalar libs Foundry (1ª vez)
cd contracts
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install Uniswap/v2-core --no-commit
forge install Uniswap/v3-core --no-commit
forge install Uniswap/v3-periphery --no-commit
forge install aave/aave-v3-core --no-commit
cd ..

# Build contratos
pnpm contracts:build

# Testes
pnpm contracts:test

# Detector off-chain (modo dev — não submete tx real)
pnpm detector:dev
```

### Variáveis de ambiente

Copie `.env.example` → `.env` e preencha. Críticas:
- `BASE_RPC_HTTP` / `BASE_RPC_WS` — Alchemy ou similar
- `EXECUTOR_PRIVATE_KEY` — chave do bot (recomendo hardware wallet ou Turnkey em prod)
- `MAX_TRADE_ETH` / `MIN_PROFIT_USD` — circuit breakers
- `KILL_SWITCH=false` (true = bot para tudo)

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
├── README.md                  # Este arquivo
├── CONTEXT.md                 # Regras, padrões, lógica
├── PROJECT_CONTEXT.md         # Visão consolidada + status
├── ARCHITECTURE.md            # Fluxos de dados, decisões
├── TODO.md                    # Pendente detalhado por fase
├── CLAUDE.md                  # Pacote portátil para IA
├── CONTRACTS.md               # Spec de smart contracts + audit pipeline
│
├── package.json               # workspace root (pnpm-only)
├── pnpm-workspace.yaml
├── .env.example
│
├── contracts/                 # Foundry project
│   ├── foundry.toml
│   ├── remappings.txt
│   ├── src/
│   │   ├── ZeusExecutor.sol   # Hot path: atomic arb + flashloan
│   │   ├── adapters/          # Adapters por DEX (UniV2, V3, Aerodrome, ...)
│   │   ├── strategies/        # WalletArb, FlashloanArb, Liquidator
│   │   └── interfaces/
│   ├── test/
│   ├── script/
│   └── lib/                   # forge install deps
│
├── apps/
│   ├── detector/              # TS — escuta mempool + dispara executor
│   └── monitor/               # TS — health factors pra liquidations
│
├── packages/
│   ├── chain-config/          # RPCs, endereços por chain
│   ├── dex-adapters/          # TS adapters pra calcular preço off-chain
│   └── shared-types/
│
├── scripts/
│   ├── deploy.ts              # Foundry deploy do executor
│   └── simulate.ts            # Backtest contra fork mainnet
│
└── docs/refs/                 # MDs externos pra expandir conhecimento da IA
```

---

## 🗺️ Roadmap (resumo)

Detalhes em [TODO.md](./TODO.md).

| Fase | Entrega | Status |
|---|---|---|
| **0** | Setup inicial (monorepo + Foundry + docs canônicos) | 🟡 Em andamento |
| **1** | ZeusExecutor.sol completo + DEX adapters (Uniswap V3 + Aerodrome) | ❌ Pendente |
| **2** | Detector TS: mempool listener + opportunity calc + tx submitter | ❌ Pendente |
| **3** | Flashloan Aave V3 integration | ❌ Pendente |
| **4** | Backtest contra fork de Base mainnet (sem custo) | ❌ Pendente |
| **5** | Deploy testnet (Base Sepolia) + simulação ao vivo 2 semanas | ❌ Pendente |
| **6** | Liquidations (Aave V3 + Compound III + Morpho) | ❌ Pendente |
| **7** | Deploy mainnet com capital pequeno + audit interno | ❌ Pendente |
| **8** | Audit externo (Certik ou similar) | ❌ Pendente |
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
