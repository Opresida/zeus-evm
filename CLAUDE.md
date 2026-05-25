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
│   ├── src/ZeusExecutor.sol  # 5 funções execute*: Arbitrage, FlashloanArbitrage,
│   │                         # Liquidation (Aave), CompoundLiquidation, MorphoLiquidation
│   ├── src/libraries/      # UniswapV3Lib + AerodromeLib (inline adapters)
│   ├── src/interfaces/     # IZeusExecutor + Aave/Compound/Morpho interfaces
│   ├── script/Deploy.s.sol # multi-chain (Base, Arb, OP — mainnet + Sepolia)
│   └── test/
│       ├── ZeusExecutor.t.sol            # 18 unit tests
│       ├── ZeusExecutor.fixes.t.sol      # 11 adversariais (Audit Pass 2 H-01/H-02/M-01/M-02)
│       └── fork/                          # 24 fork tests (arb + flashloan + liquidations 3 protocolos)
├── apps/
│   ├── detector/           # TS — main loop: WSS → scan → filter → simulate (cross-DEX, radar passivo)
│   ├── backtest/           # TS — replay histórico de blocos
│   ├── monitor/            # TS — DRY_RUN: discovery Aave+Compound+Morpho (read-only)
│   └── liquidator/         # TS — pipeline dispatch: calc → sim → build → dispatch
│       ├── src/protocols/aave/      # calculator + simulator + builder Aave V3
│       ├── src/protocols/compound/  # ABI + cometCache + discovery + calc + sim + builder Compound III
│       ├── src/slippageCache.ts     # cache TTL 60s pra UniV3 quotes
│       ├── src/eventDecoder.ts      # decode LiquidationExecuted post-tx + delta real vs esperado
│       ├── src/priceUtils.ts        # wei → "$12.45" humano + USD estimate
│       ├── src/pipeline.ts          # runAavePipeline + runCompoundPipeline
│       └── src/dispatcher.ts        # 3 modos: dryrun | testnet | mainnet
├── packages/
│   ├── chain-config/       # BASE_MAINNET + BASE_SEPOLIA + ARBITRUM + OPTIMISM + target-pairs
│   ├── dex-adapters/       # quoteUniswapV3 + quoteAerodrome (off-chain pricing)
│   ├── strategy/           # opportunities (crossDex/filters/fanout) + executor (txBuilder/simulator/abi)
│   ├── aave-discovery/     # NOVO — package shared (ABIs + reserves cache + discovery + types) reusável
│   └── shared-types/
└── docs/refs/              # MDs externos pra expandir conhecimento da IA
```

---

## 🗺️ Estado atual (snapshot 2026-05-25)

### ✅ Pronto
- **Fases 0-5a**: Setup + ZeusExecutor + Detector + Flashloan Aave + Track A+B + Deploy testnet (ver histórico TODO.md)
- **Trilha 1 (Liquidações Aave V3)**: contrato + monitor + 4 fork tests — $8.643 profit em fork
- **Sprint 1 Aave V3 multi-chain**: 3 chains testnet armed (Base/Arb/OP Sepolia)
- **Sprint 3 Morpho subgraph fix** (2026-05-25): schema-fix Messari-format, 200 positions ativas reais detectadas em Base mainnet
- **Compound chunking** (2026-05-25): `eth_getLogs` em janelas de 9999 blocos pra free tier dRPC
- **Redeploy ZeusExecutor v6** (2026-05-25): 3 chains, todas verified, com Aave + Compound + Morpho
- **Security Audit Pass 1 + Pass 2** (2026-05-25): 2 HIGH + 4 MEDIUM identificados e **CORRIGIDOS** (H-01 Morpho approval bounded+reset, H-02 maxTradePerToken map, M-01 pre-existing balance snapshot, M-02 flashloanAmount explícito). 11 novos testes adversariais
- **Liquidator Sprint 1 Aave V3** (2026-05-25): novo `apps/liquidator/` com pipeline completo (calculator binary search + simulator eth_call + builder calldata + dispatcher 3 modos)
- **Discovery automática Aave V3** (2026-05-25): subgraph → Multicall3 HF → resolve par dominante (collateral/debt). Live em Base mainnet: 29 at-risk detectados
- **Event decoder + log humanizado USD** (2026-05-25): captura profit real pós-tx, log `💰 $12.45 (gas $0.32, líquido $12.13) | 🎯 calibrado` + delta real-vs-esperado
- **Shared discovery package** (2026-05-25): `@zeus-evm/aave-discovery` workspace package, reusável entre apps
- **Liquidator Sprint 2 Compound III** (2026-05-25): pipeline completo Compound (5+8 collaterals cacheados Base mainnet, discovery via event scan chunked, `quoteCollateral` on-chain)
- **Slippage cache TTL 60s** (2026-05-25): wrapper sobre `quoteUniswapV3` com métricas hit/miss
- **Bug fix calculator**: clamp `Math.max(1, floor)` evita `BigInt(NaN)` quando MIN_DEBT_USD < 1
- **Pipeline refactor calc-first** (2026-05-25): calculator roda mesmo sem executor — alimenta cache + LOGA decision teórica em DRY_RUN mainnet
- **Total**: **53/53 Foundry tests** · **9/9 typecheck workspaces** (incluindo packages/aave-discovery + apps/liquidator)

### 🟡 Em andamento (próxima sessão)
- **Sprint 3 Morpho pipeline TS** — discovery + calculator + builder + simulator + IRM enrichment on-chain
- 2 semanas DRY_RUN mainnet observação calibração

### 📅 Roadmap pós-Sprint 3 (decidido 2026-05-25)
- **Fase 7**: Deploy executor em Base mainnet + 4 semanas observação capital pequeno
- **Sprint 4 (JIT Liquidity)**: motor #2 descorrelacionado, requer mempool premium (~$199/mês)
- **Sprint 5 (Backrun dislocation)**: motor #3 descorrelacionado, reusa mempool
- **Avalanche expansion**: Aave V3 only, +500-800 borrowers
- **Audit externo**: Trail of Bits / Spearbit quando capital > $50k

**Tese de 3 motores descorrelacionados:** ZEUS fatura em qualquer mercado (#1 crash, #2 volume, #3 volatilidade).

**Detalhes completos em [TODO.md](./TODO.md).**

### 🔑 Decisões já tomadas
- Provider RPC: **dRPC** primário + Alchemy fallback
- Carteira testnet dedicada: `0xE060821b253ec9dad4BDe139c5661Bc07A6AcBB4` (testnet-only)
- Contratos testnet verified:
  - **Base Sepolia v6** (Aave + Compound + Morpho): `0xe38298B4d242d0D1C45696a96c4C588926Cf1139`
  - **Arbitrum Sepolia v6**: `0xe48473D75805886Ac4162B1304EAB6b8F93C5faa`
  - **Optimism Sepolia v6**: `0xe48473D75805886Ac4162B1304EAB6b8F93C5faa` (mesmo addr de Arb via nonce alinhado)
  - _Anteriores arquivados: Base v2 `0xe53cb8c...`, Arb/OP v1 `0xd7e8fde...`_

### ⏸️ Aguardando decisão do Humberto
- **Estratégia com edge** (Fase 4c) ← bloqueador principal
- Multisig provider — antes de Fase 7
- Capital inicial concreto — antes de Fase 7
- Audit provider — antes de Fase 8

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
