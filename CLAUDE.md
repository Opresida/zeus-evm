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
2. **Flashloan arb** — Aave V3 (0.05% fee)

**Três estratégias:**
- Cross-DEX em medium-cap tokens
- Triangular intra-DEX (Uniswap V3 fee tiers)
- Liquidations (Aave V3 + Compound III + Morpho)

**Chain inicial:** Base (Coinbase L2). Multi-chain depois.

> Projeto exclusivo Humberto + Claude. Danton NÃO está envolvido.

---

## 🧱 Stack

- **Off-chain:** TypeScript + Node 22 + `viem`
- **Smart contracts:** Solidity 0.8.27 + Foundry (via_ir, optimizer 1M runs)
- **Monorepo:** pnpm 10+ workspaces (pnpm-only — npm install é bloqueado)
- **Provider:** Alchemy primário + público fallback
- **Flashloan:** Aave V3 universal
- **Deploy:** Fly.io (igual Zeus Solana e MAZARI)
- **Monitoring:** Tenderly + Discord webhook + pino logs

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
├── contracts/              # Foundry: Solidity + tests + scripts
│   ├── src/ZeusExecutor.sol
│   ├── src/adapters/
│   ├── src/strategies/
│   └── test/
├── apps/
│   ├── detector/           # TS — mempool listener + arb executor
│   └── monitor/            # TS — health factors pra liquidations
├── packages/
│   ├── chain-config/       # addresses por chain (Base, depois Arb, OP)
│   ├── dex-adapters/       # TS adapters pra pricing off-chain
│   └── shared-types/
├── scripts/                # deploy.ts, simulate.ts
└── docs/refs/              # MDs externos pra expandir conhecimento da IA
```

---

## 🗺️ Estado atual (snapshot 2026-05-22)

### ✅ Pronto
- Fase 0: setup inicial (monorepo + Foundry + docs canônicos + stubs)

### ❌ Pendente pra pleno funcionamento
- **Fase 1:** ZeusExecutor.sol completo + adapters UniV3 e Aerodrome (3-4 dias)
- **Fase 2:** Detector TS off-chain (4-5 dias)
- **Fase 3:** Flashloan Aave V3 (2-3 dias)
- **Fase 4:** Backtest fork mainnet (2-3 dias)
- **Fase 5:** Testnet Base Sepolia 2 semanas
- **Fase 6:** Liquidations (1 semana)
- **Fase 7:** Deploy mainnet capital pequeno + 4 semanas observação
- **Fase 8:** Audit externo Certik (1-2 semanas)
- **Fase 9:** Scale + multi-chain

**Detalhes em [TODO.md](./TODO.md).**

### ⏸️ Aguardando decisão do Humberto
- Quando fazer push GitHub
- Provider mempool: Alchemy / Blocknative / Reth self-hosted
- Multisig provider
- Capital inicial concreto
- Audit provider

---

## 🔑 Decisões já tomadas

- ✅ Chain inicial: **Base** (Coinbase L2)
- ✅ Estratégias: Cross-DEX + Triangular + Liquidations
- ✅ Stack: TypeScript + viem + Foundry (não ethers, não Hardhat)
- ✅ Flashloan: Aave V3 primário
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

Quando voltar ao projeto em outra sessão/máquina, ler esses 7 arquivos é suficiente.
