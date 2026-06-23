# ZEUS EVM — MEV on-chain (Base + multi-chain)

<p align="center">
  <strong>Bot de MEV on-chain em EVM. Flashloan-first. Self-custody. Atômico ou nada.</strong><br>
  <em>3 motores descorrelacionados: Liquidations · Cross-DEX Arb · Backrun.</em>
</p>

**Chain inicial:** Base (Coinbase L2) · **Code-ready:** Arbitrum · Optimism · Polygon · Avalanche
**Time:** Humberto (product/strategy) + Claude (engineering)

**Status (snapshot 2026-06-15):**
- **4 contratos (v8 split, EIP-170):** BribeManager + ZeusLiquidator + ZeusArbExecutor + ZeusMoonwellLiquidator
- **Flashloan 3 fontes** (Aave V3 / Morpho Blue / Balancer V2) — Morpho e Balancer com **0% fee** (multi-fonte) + multi-hop N steps
- **5 protocolos de lending** (Motor 1): Aave V3 · Compound III · Morpho Blue · Seamless · Moonwell
- **Motor 2 (MIS) virou motor de execução cross-DEX** — varre ineficiência por persistência + sizing de flashloan + **detecção triangular** + inteligência espelhada; **execução OFF por default** (`ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun` → só observa e grava no ledger)
- **Motor 3 (backrun) construído** — EV gate competitor-aware + bribe + `/metrics`; **continua bloqueado** esperando feed de mempool premium
- **Camada OIE construída (2026-06-15)** — scoring (Opportunity/Protocol/Pool/Token) + ledger DuckDB; gates EV cientes de OEV/competidor; thresholds adaptativos (Etapa C, opt-in) + exporter Prometheus + 3 dashboards Grafana (Etapa D parcial)
- **Testes:** 78/79 unit Foundry (1 skip) + fork verde contra Base mainnet via Alchemy · ~404 testes TS (execution-utils 336/336) · typecheck 13/13
- Contratos deployados em **Sepolia (testnet), NÃO mainnet**

**🆕 2026-06-23 (detalhes em `CLAUDE.md`):** expansão de DEX do Motor 2 (Slipstream + forks UniV3/UniV2 + adapter `PancakeV3Lib`/`DexType.PancakeV3`) + toggle remoto + cola do painel (Supabase + `x-zeus-secret` + `zeus.heartbeat`) — tudo na `main`. Endereços verificados on-chain (dackie/rocket removidos). **RPC = Alchemy primário.** Redeploy testnet v8. **Falta:** envs da Vercel + `GENERIC_WEBHOOK_URL` + Fly.io + 2 semanas DRY_RUN.

> ⚠️ **Lucro real até agora: US$ 0.** A lógica dos 3 motores está provada (fork tests com lucro), mas o bot
> ainda NÃO está em produção. Os lucros dos fork tests são prova de LÓGICA em cenário fabricado — não dinheiro
> que estava na mainnet. Ver seção "Realidade" abaixo.

---

## 🎯 O que é

Bot de MEV on-chain, **flashloan-first** (Aave V3, 0.05% fee) — borrow → operar → repay tudo em **1 tx atômica**.
Se o lucro não cobrir o custo, a tx inteira reverte (nunca trava capital no meio).

### Os 3 motores descorrelacionados

| Motor | O que faz | Ganha quando | Estado |
|---|---|---|---|
| **1 — Liquidations** | Liquida posições underwater em protocolos de lending, embolsa o bônus (5-10%) | Crash / queda | Código pronto (5 protocolos) |
| **2 — Cross-DEX Arb** | Compra barato num DEX, vende caro em outro (mesmo instante) | Volume alto | Motor de execução pronto (OFF default) + triangular |
| **3 — Backrun** | Opera logo atrás de um swap-baleia pra capturar a dislocação | Volatilidade | Máquina pronta (falta mempool) |

A tese: **em qualquer cenário de mercado, pelo menos um motor está trabalhando.** Os três compartilham o mesmo
dataset (os colaterais sub-servidos) e a mesma infra on-chain.

---

## ⚠️ Realidade (honestidade > otimismo)

**Nosso edge NÃO é velocidade.** Arb de blue-chips (ETH/USDC) em <1 bloco é dominado por bots top
(Wintermute, Jump...) — ali a gente perde. **Nosso edge é cobertura + persistência em mercados sub-servidos:**
LSDs (cbETH, wstETH, sAVAX), stables fragmentadas, e protocolos de nicho (Morpho, Moonwell, Seamless) onde
há poucos competidores.

**Achado estratégico (2026-06-15):** liquidação na Base está se fechando por **OEV capture** — Aave V3 ~85%
(Chainlink SVR), Moonwell ~99% (MEV tax). **Morpho Blue continua ABERTO (0% recapture) = nosso único edge real
em liquidação.** A estratégia decantou em: **núcleo = liquidação Morpho** (lumpy, paga muito no crash) +
**baseline = arb cross-DEX** (pequeno, contínuo, paga a infra). Nota competitiva honesta: **~7,5/10 como software,
~4,5/10 como competidor que ganha dinheiro hoje** (falta fosso de orderflow/latência). Detalhes em
[`docs/refs/`](./docs/refs) (competitive-landscape · engine-strategy · morpho-profit-projection).

O **Motor 2 (MIS)** virou **motor de execução cross-DEX** (`arbDispatcher` + `arbOpportunity`), mas a **execução
fica DESLIGADA por default** (`ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun` → sem env deliberada continua só
observando e gravando no ledger). Ranqueia ineficiências por **PERSISTÊNCIA** (magnitude × duração), não por pico
— porque ineficiência de 1 bloco é guerra de latência (perdemos) e ineficiência persistente é o nosso edge. Usa o
quoter on-chain pra calcular o **tamanho ótimo do flashloan** + descartar pool raso (slippage disfarçado), e já
**detecta arbitragem triangular** (grafo de tokens + `findTriangularCycles`; execução triangular é o próximo passo).
Travas antes de qualquer disparo: simula (eth_call) + EV gate, re-cota fresco no dispatch, flashloan-only/atômico
(falha = só gás), circuit breakers validados na config zod e `EXECUTOR_PRIVATE_KEY` exclusiva.

**Lucro real só aparece com:** (1) deploy em mainnet; (2) oportunidade real (acontece em movimento de mercado);
(3) ganhar a corrida contra concorrentes; (4) dias de coleta do MIS/ledger pra revelar onde mora a ineficiência.

---

## 🚀 Como rodar

### Pré-requisitos
- Node.js 22+ · pnpm 10+ (monorepo é **pnpm-only**, npm bloqueado) · [Foundry](https://book.getfoundry.sh)
- RPC: **dRPC** (reads/discovery) + **Alchemy** (fork tests + mempool futuro) — ver `.env.example`

### Setup + comandos

```bash
pnpm install                 # deps (pnpm-only)

cd contracts                 # libs Foundry (1ª vez)
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
cd ..

pnpm contracts:build         # build contratos (4 contratos v8 split)
pnpm typecheck               # 13/13 workspaces
pnpm contracts:test          # unit tests Foundry (sem fork)

# Fork tests contra Base mainnet (usa Alchemy automático via ALCHEMY_API_KEY do .env)
pnpm contracts:test:fork
# → 78/79 unit (1 skip) + suíte fork verde, inclui a prova de LUCRO dos 3 motores

# MIS — Motor 2 (execução OFF por default: ARB_EXECUTION_ENABLED=false / ARB_MODE=dryrun → só observa e grava no ledger DuckDB)
MIS_CHAIN=base pnpm --filter @zeus-evm/mis-scanner start       # ou MIS_CHAIN=avalanche

# Discovery scraper — varredura GeckoTerminal → auto-targets pro detector
pnpm --filter @zeus-evm/discovery-scraper start

# Confirmação on-chain read-only (endereços/ABIs/premium flashloan nas 3 chains)
pnpm --filter @zeus-evm/mis-scanner exec tsx scripts/confirmOnchain.ts

# Liquidator DRY_RUN (discovery read-only, sem submeter; OIE prioriza Morpho via OEV)
CHAIN_ID=8453 LIQUIDATOR_MODE=dryrun pnpm --filter @zeus-evm/liquidator start
```

### Variáveis de ambiente (`.env.example` → `.env`)
- `BASE_RPC_HTTP` / `POLYGON_RPC_HTTP` / `AVALANCHE_RPC_HTTP` — reads/discovery (dRPC)
- `ALCHEMY_API_KEY` — fork tests (Alchemy free serve archive; dRPC free bloqueia) + mempool futuro
- `EXECUTOR_PRIVATE_KEY` — **testnet-only** em dev; multisig + hardware em prod
- `LIQUIDATOR_ADDRESS_*` / `EXECUTOR_CONTRACT_ADDRESS_*` — endereços por chain
- `MAX_TRADE_ETH` / `MIN_PROFIT_USD` / `KILL_SWITCH` — circuit breakers (default fail-safe)

---

## 🧱 Stack

| Camada | Tech |
|---|---|
| **Off-chain** | TypeScript + Node 22 + `viem` (monorepo pnpm) |
| **Smart contracts** | Solidity 0.8.27 + Foundry (via_ir, optimizer) |
| **Flashloan** | Aave V3 (universal, 0.05% fee) |
| **Lending (Motor 1)** | Aave V3 · Compound III · Morpho Blue · Seamless · Moonwell |
| **DEXs** | Uniswap V3 · Aerodrome (Base) · Velodrome (OP) · Trader Joe LB (Avalanche) |
| **RPC** | dRPC (reads) + Alchemy (fork/mempool) |
| **Deploy** | Fly.io · **Monitoring:** Tenderly + Discord + pino |

---

## 📁 Estrutura

```
zeus-evm/
├── contracts/                       # Foundry — 4 contratos v8 split (EIP-170)
│   ├── src/
│   │   ├── BribeManager.sol            # gorjeta MEV ao block.coinbase (compartilhado)
│   │   ├── ZeusLiquidator.sol          # liquidation Aave + Compound + Morpho (Morpho = função)
│   │   ├── ZeusArbExecutor.sol         # arb cross-DEX + flashloan 3 fontes (Aave/Morpho/Balancer) + backrun
│   │   ├── ZeusMoonwellLiquidator.sol  # liquidation Moonwell (fork Compound V2, contrato à parte)
│   │   ├── libraries/                  # UniswapV3Lib + AerodromeLib (inline)
│   │   └── interfaces/                 # Aave / Compound / Morpho / Moonwell / Balancer
│   ├── test/ + test/fork/              # 115 funções (9 arquivos: 4 unit + 5 fork, inclui MotorsProfit.fork.t.sol)
│   ├── script/Deploy.s.sol             # deploy multi-chain dos 4 contratos
│   └── fork-test.sh                    # roda fork tests via Alchemy
├── apps/                            # 7 apps
│   ├── liquidator/                  # Motor 1 — pipeline calc→sim→build→dispatch (5 protocolos; OIE prioriza Morpho via OEV)
│   ├── mis-scanner/                 # Motor 2 — execução cross-DEX OFF default (arbDispatcher) + triangular + flash sizing + derivação colaterais + inteligência espelhada + ledger
│   ├── backrun-engine/             # Motor 3 — EV gate competitor-aware + bribe + bundling (Flashbots/Atlas/Blocknative)
│   ├── discovery-scraper/          # varredura GeckoTerminal → auto-targets pro detector
│   ├── detector/                    # arb radar — consome varredura + grava no ledger DuckDB
│   ├── monitor/ + backtest/
├── packages/                        # 6 packages
│   ├── chain-config/                # Base + Arb + OP + Polygon + Avalanche (+ Sepolia)
│   ├── dex-adapters/                # quotes + pricing local (UniV3 tick, Aero, Trader Joe LB)
│   ├── execution-utils/             # arb/MIS + gates + intelligence DuckDB + scoring OIE + pnlReconciler + senderRegistry + prometheus/health
│   ├── strategy/                    # opportunities + executor (txBuilder/simulator)
│   ├── aave-discovery/              # ABIs + reserves cache + discovery on-chain + BorrowerCache
│   └── shared-types/
├── docs/                            # OIE_PROGRESS.md + refs/ (competitive-landscape, engine-strategy, morpho-profit-projection, infra-costs, cross-dex-arb-status, fly-deploy)
├── deploy/fly/                      # Dockerfile + *.toml (Fly.io, volume persistente pro ledger)
└── scripts/generate_status_report.py   # relatório executivo (PDF)
```

---

## 🗺️ Roadmap (resumo — detalhes em [TODO.md](./TODO.md))

| Item | Status |
|---|---|
| Contratos v8 (4) + audit interno (B-1 a B-7) | ✅ |
| Motor 1: 5 protocolos (Aave/Compound/Morpho/Seamless/Moonwell) | ✅ código |
| Multi-chain code-ready (Base/Arb/OP/Polygon/Avalanche) | ✅ |
| Motor 2: MIS (multicall + derivação on-chain + flash sizing + gate de profundidade) | ✅ |
| Motor 2: motor de execução cross-DEX (arbDispatcher, OFF default) + detecção triangular | ✅ código |
| Motor 2: adapter Trader Joe LB (Avalanche) | ✅ |
| Motor 3: backrun engine (EV gate competitor-aware + bribe + bundling) | ✅ código |
| Flashloan 3 fontes (Aave/Morpho/Balancer, 0% multi-fonte) + multi-hop N steps | ✅ |
| Camada OIE: scoring + ledger DuckDB + gates cientes de OEV/competidor | ✅ |
| OIE Etapa C: thresholds adaptativos (opt-in, `ADAPTIVE_THRESHOLDS_ENABLED=false`) | ✅ |
| OIE Etapa D: exporter Prometheus + 3 dashboards Grafana (meta era 8) | 🟡 parcial |
| Deploy Fly.io (Dockerfile + deploy/fly/*.toml, volume persistente) | ✅ |
| Fork tests de lucro dos 3 motores (Base mainnet, Alchemy) | ✅ 78/79 unit + fork verde |
| Deploy mainnet (4 contratos) + capital + multisig | ❌ (testnet only) |
| 2 semanas DRY_RUN + dias de coleta MIS/ledger | 🟡 próximo |
| Motor 3 ao vivo (mempool premium Alchemy ~$199/mês) | ❌ pós-receita |
| Audit externo (capital > $50k) | ❌ |

---

## 🛡️ Princípios de risco (não-negociáveis)

1. **Atomic-only** — qualquer falha reverte a tx inteira. Sem estado travado.
2. **Self-custody com cap por tx** — `MAX_TRADE` no contrato; kill switch para tudo em <1 bloco.
3. **Min profit on-chain** — tx reverte se lucro < threshold.
4. **Flashloan-first** — sem capital próprio em risco até o primeiro lucro.
5. **Sem reuso de chave** entre projetos · **validar antes de escalar** (testnet/fork → DRY_RUN mainnet → capital pequeno → audit). Hoje: contratos em **Sepolia**, lucro real **US$ 0**.

---

## 👥 Time

- **Humberto** — product, strategy, decisões executivas
- **Claude (Anthropic)** — engineering, implementação, validação

Comunicação direta, iterativa, PT-BR.

## 📜 Licença

Proprietário. Todos os direitos reservados.
