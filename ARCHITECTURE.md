# ARCHITECTURE — ZEUS EVM

Estrutura de pastas, fluxos de dados e decisões arquiteturais.

---

## 🧭 Visão geral

ZEUS EVM é um **monorepo pnpm** com 3 camadas:

1. **`contracts/`** — Foundry project com smart contracts on-chain (Solidity)
2. **`apps/`** — Aplicações off-chain (TypeScript) que disparam transações
3. **`packages/`** — Bibliotecas compartilhadas entre apps

```
┌────────────────────────────────────────────────────────────────┐
│                    ZEUS EVM (monorepo)                          │
└────────────────────────────────────────────────────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────┐  ┌────────────────────┐  ┌──────────────────┐
│   contracts/    │  │       apps/        │  │    packages/     │
│   (Solidity)    │  │    (TypeScript)    │  │   (shared TS)    │
│                 │  │                    │  │                  │
│ ZeusExecutor    │  │ detector           │  │ chain-config     │
│ + adapters DEX  │  │ monitor            │  │ dex-adapters     │
│ + flashloan     │  │                    │  │ shared-types     │
│ + liquidator    │  │                    │  │                  │
└─────────────────┘  └────────────────────┘  └──────────────────┘
        │                       │                       │
        └───────── interagem via viem + ABI ────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │  Base mainnet   │
                   │  (Coinbase L2)  │
                   │                 │
                   │ Aave V3, Uniswap│
                   │ V3, Aerodrome,  │
                   │ BaseSwap...     │
                   └─────────────────┘
```

---

## 📁 Estrutura completa

```
zeus-evm/
│
├── 📄 README.md
├── 📄 CONTEXT.md
├── 📄 PROJECT_CONTEXT.md
├── 📄 ARCHITECTURE.md          ← este arquivo
├── 📄 TODO.md
├── 📄 CLAUDE.md
├── 📄 CONTRACTS.md
│
├── 📄 package.json             # workspace root (pnpm-only)
├── 📄 pnpm-workspace.yaml      # com catalog de versoes
├── 📄 .gitignore
├── 📄 .env.example
│
├── contracts/                  # ═══ FOUNDRY PROJECT ═══
│   ├── foundry.toml
│   ├── remappings.txt
│   ├── src/
│   │   ├── ZeusExecutor.sol    # Hot path principal
│   │   ├── adapters/
│   │   │   ├── UniswapV2Adapter.sol
│   │   │   ├── UniswapV3Adapter.sol
│   │   │   ├── AerodromeAdapter.sol
│   │   │   ├── CurveAdapter.sol
│   │   │   └── BalancerAdapter.sol
│   │   ├── strategies/
│   │   │   ├── WalletArbStrategy.sol
│   │   │   ├── FlashloanArbStrategy.sol
│   │   │   └── LiquidatorStrategy.sol
│   │   └── interfaces/
│   │       ├── IZeusExecutor.sol
│   │       ├── IDexAdapter.sol
│   │       └── IAaveFlashloanReceiver.sol
│   ├── test/
│   │   ├── ZeusExecutor.t.sol
│   │   ├── adapters/
│   │   ├── strategies/
│   │   └── fork/               # testes com fork Base mainnet
│   ├── script/
│   │   ├── DeployExecutor.s.sol
│   │   └── UpgradeExecutor.s.sol
│   └── lib/                    # forge install deps (gitignored)
│       ├── forge-std/
│       ├── openzeppelin-contracts/
│       ├── v2-core/
│       ├── v3-core/
│       ├── v3-periphery/
│       └── aave-v3-core/
│
├── apps/
│   │
│   ├── detector/               # ═══ DETECTOR OFF-CHAIN ═══
│   │   ├── package.json        # @zeus-evm/detector
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts        # entry point
│   │   │   ├── config.ts       # le .env + valida com zod
│   │   │   ├── chains.ts       # config por chain (Base, depois Arb, OP)
│   │   │   ├── mempool/
│   │   │   │   ├── alchemy.ts  # mempool subscription via Alchemy
│   │   │   │   └── decoder.ts  # decode pending txs
│   │   │   ├── pricing/
│   │   │   │   ├── uniswapV3.ts# read tick & price on-chain
│   │   │   │   ├── aerodrome.ts
│   │   │   │   └── aggregator.ts # comparacao entre fontes
│   │   │   ├── opportunities/
│   │   │   │   ├── crossDex.ts # detector cross-DEX
│   │   │   │   ├── triangular.ts # detector intra-DEX
│   │   │   │   └── filters.ts  # min profit, max slippage, ...
│   │   │   ├── executor/
│   │   │   │   ├── txBuilder.ts# constroi calldata do ZeusExecutor
│   │   │   │   ├── submitter.ts# envia tx (ou bundle Flashbots)
│   │   │   │   └── simulator.ts# eth_call antes de enviar
│   │   │   ├── monitoring/
│   │   │   │   ├── metrics.ts  # success_rate, avg_landed_time, profit
│   │   │   │   └── alerts.ts   # Discord webhook
│   │   │   └── logger.ts       # pino structured logs
│   │   └── tests/
│   │
│   └── monitor/                # ═══ LIQUIDATIONS MONITOR ═══
│       ├── package.json        # @zeus-evm/monitor
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── protocols/
│           │   ├── aaveV3.ts
│           │   ├── compoundV3.ts
│           │   └── morpho.ts
│           ├── healthFactor.ts # calcula HF on-chain
│           └── liquidator.ts   # dispara liquidation no ZeusExecutor
│
├── packages/
│   │
│   ├── chain-config/           # ═══ CONFIGURACOES POR CHAIN ═══
│   │   ├── package.json        # @zeus-evm/chain-config
│   │   ├── src/
│   │   │   ├── base.ts         # addresses Base (Aave, Uniswap, Aerodrome)
│   │   │   ├── arbitrum.ts     # futuro
│   │   │   ├── optimism.ts     # futuro
│   │   │   ├── types.ts        # ChainConfig type
│   │   │   └── index.ts
│   │   └── tests/
│   │
│   ├── dex-adapters/           # ═══ ADAPTERS TS PRA OFF-CHAIN PRICING ═══
│   │   ├── package.json        # @zeus-evm/dex-adapters
│   │   ├── src/
│   │   │   ├── uniswapV2.ts    # getAmountOut, reserves
│   │   │   ├── uniswapV3.ts    # quoter, tick math
│   │   │   ├── aerodrome.ts    # stable + volatile pools
│   │   │   ├── curve.ts
│   │   │   ├── balancer.ts
│   │   │   └── index.ts
│   │   └── tests/
│   │
│   └── shared-types/           # ═══ TIPOS COMPARTILHADOS ═══
│       ├── package.json        # @zeus-evm/shared-types
│       ├── src/
│       │   ├── swap.ts         # SwapStep, ArbitrageParams (mirror Solidity)
│       │   ├── opportunity.ts  # Opportunity, OpportunityType
│       │   ├── pool.ts         # Pool, PoolType
│       │   └── index.ts
│       └── tests/
│
├── scripts/                    # ═══ SCRIPTS DEVOPS ═══
│   ├── deploy.ts               # deploy contracts (chama Foundry script)
│   ├── simulate.ts             # backtest off-chain contra fork
│   └── seed-addresses.ts       # popula chain-config a partir de docs
│
└── docs/refs/                  # ═══ MATERIAL EXTERNO PRA IA ═══
    # Humberto coloca aqui MDs com referencias:
    # - audit-mindset.md
    # - flashloans-evm.md
    # - mev-patterns.md
    # - gas-optimization.md
    # - liquidations-mev.md
```

---

## 🌊 Fluxos de dados

### Fluxo 1 — Cross-DEX arb (Modalidade Capital Próprio)

```
[apps/detector]
  │
  │ (1) Subscribe a pending txs do mempool via Alchemy WSS
  │
  ├──► Mempool listener (alchemy.ts)
  │       │
  │       │ (2) Detecta swap grande (>$10k) em DEX X
  │       │
  │       ▼
  │     opportunities/crossDex.ts
  │       │
  │       │ (3) Calcula preço esperado pos-swap em DEX X
  │       │ (4) Compara com preço atual em DEX Y
  │       │ (5) Se gap > minProfitUsd + custos:
  │       │     monta SwapStep[] {DEX Y → DEX X}
  │       │
  │       ▼
  │     executor/simulator.ts
  │       │
  │       │ (6) eth_call no ZeusExecutor pra confirmar profit
  │       │ (7) Se simulação OK:
  │       │
  │       ▼
  │     executor/txBuilder.ts
  │       │ (8) Codifica calldata do executeArbitrage(params)
  │       │
  │       ▼
  │     executor/submitter.ts
  │           (9) walletClient.sendTransaction(...)
  │           (10) Espera receipt
  │
[chain: Base mainnet]
        │
        ▼
   [ZeusExecutor.sol :: executeArbitrage]
        │
        │ (a) require(!killed)
        │ (b) require(msg.sender == owner ou operator)
        │ (c) require(params.amountIn <= MAX_TRADE_ETH)
        │
        ├──► for each SwapStep in params.steps:
        │       call dex-adapter.swap(step)
        │
        │ (d) Computa profit final
        │ (e) require(profit >= params.minProfitWei) ELSE revert
        │ (f) Transfer profit → profitReceiver
        │ (g) emit ArbitrageExecuted
        │
        ▼
[apps/detector] recebe receipt, atualiza métricas
```

### Fluxo 2 — Flashloan arb (Modalidade Flashloan)

```
[apps/detector]
  │
  │ (1) Detector identifica oportunidade que precisa size > capital próprio
  │ (2) Chama executor.executeFlashloanArbitrage(asset, amount, params)
  │
[ZeusExecutor.sol :: executeFlashloanArbitrage]
  │
  │ (a) IPool(aaveV3).flashLoanSimple(this, asset, amount, params, 0)
  │
  ▼
[Aave V3 Pool]
  │ (b) Transfere `amount` de `asset` → ZeusExecutor
  │ (c) Chama ZeusExecutor.executeOperation(asset, amount, premium, initiator, params)
  │
[ZeusExecutor.sol :: executeOperation (callback Aave)]
  │
  │ (d) Decode params → ArbitrageParams
  │ (e) for each SwapStep: execute swap
  │ (f) require(balance(asset) >= amount + premium) ELSE revert
  │ (g) approve(aaveV3, amount + premium)
  │ (h) profit = balance(profitToken) - (amount inicial em profitToken se aplicável)
  │ (i) require(profit >= params.minProfitWei) ELSE revert
  │ (j) Transfer profit → profitReceiver
  │
  ▼
[Aave V3 Pool]
  │ (k) Puxa `amount + premium` de volta de ZeusExecutor
  │
  ▼
[apps/detector] recebe receipt
```

### Fluxo 3 — Liquidations

```
[apps/monitor]
  │
  │ (1) Loop: a cada 2s, lê posições do Aave V3
  │ (2) Calcula health factor de cada posição
  │ (3) Se HF < 1.0 detectado em position com debt > minSize:
  │
  ├──► protocols/aaveV3.ts
  │       (4) Calcula collateral + bonus disponível
  │       (5) Calcula custo: gas + flashloan fee + swap slippage
  │       (6) Se profit líquido > MIN_PROFIT_USD:
  │
  ▼
[ZeusExecutor.sol :: liquidatePosition]
  │
  │ (a) flashloan(debtAsset, debtAmount)
  │ (b) callback executeOperation:
  │       i)   aaveV3.liquidationCall(user, collateralAsset, debtAsset, debtAmount, false)
  │       ii)  recebe collateral + bonus
  │       iii) swap collateral → debtAsset (pra repagar flashloan)
  │       iv)  approve aave pra repay
  │       v)   profit residual → profitReceiver
```

---

## 🧩 Decisões arquiteturais

### Por quê Foundry e não Hardhat?
- **Velocidade:** `forge test` é 10-100x mais rápido que Hardhat
- **Fuzzing nativo:** property-based tests built-in
- **Solidity-first:** testes em Solidity (não JS), mais natural pra contratos
- **Forks nativos:** `vm.createFork()` é first-class
- **Comunidade:** Paradigm, Optimism, Aave V3 — todos usam Foundry hoje

### Por quê viem e não ethers?
- **Type safety nativo:** sem precisar declarar tipos manualmente
- **Mais leve:** ~20kb vs 180kb do ethers
- **Mais moderno:** novos protocolos suportam viem primeiro
- **Tree-shaking funciona:** ethers v6 ainda tem overhead

### Por quê monorepo pnpm e não nx/turborepo?
- Consistência com MAZARI (todos projetos do Humberto usam pnpm workspaces)
- `catalog:` resolve versão compartilhada sem ferramenta extra
- Tooling minimalista — não precisa de orchestrator pra esse tamanho

### Por quê via_ir + optimizer 1M runs?
- `via_ir` ativa o Yul intermediate representation = código mais otimizado
- 1M runs = otimiza pra execução (não pra deploy size) — hot path
- Trade-off: deploy custa mais gas, mas cada `executeArbitrage` é mais barato

### Por quê separar detector e monitor em apps diferentes?
- **Detector** roda em loop reativo (mempool subscription)
- **Monitor** roda em loop pollado (a cada N segundos)
- Diferentes características de carga → vale separar
- Podem rodar em hosts diferentes se precisar escalar

### Por quê não usar React Router pra dashboard?
- Sem dashboard inicial — todos os outputs vão pra logs estruturados + Discord alerts
- Dashboard é Fase futura (provavelmente Grafana ou app dedicado)

### Por quê Base como chain inicial e não Arbitrum?
- Coinbase ecosystem em alta (2025-26)
- Gas marginalmente mais barato que Arbitrum
- Aerodrome (DEX dominante) tem características únicas (ve(3,3) economics)
- Aave V3 ativo em ambas, mas Base tem maior crescimento de TVL
- Decisão pode ser revisada se Base perder momentum

---

## 🔌 Dependências externas planejadas

### Solidity (Foundry libs)
- `OpenZeppelin/openzeppelin-contracts` — Ownable2Step, ReentrancyGuard, Pausable, SafeERC20
- `Uniswap/v2-core` — interfaces UniV2 (pra adapters)
- `Uniswap/v3-core` + `v3-periphery` — Quoter, swap interfaces, TickMath
- `aave/aave-v3-core` — IPool, IFlashLoanReceiver
- `forge-std` — Test, Vm, console2

### TypeScript (npm)
- `viem` (catalog) — interação Web3
- `zod` (catalog) — validação de env e config
- `pino` (catalog) — logs estruturados
- `dotenv` (catalog) — load `.env`
- `tsx` (catalog) — execution
- `vitest` (catalog) — testes

---

## 🚢 Deploy planejado

### Etapa 1 — Local dev
- Foundry rodando contra fork local
- Detector em watch mode (`tsx watch`)

### Etapa 2 — Testnet Base Sepolia
- Deploy via `forge script` com verificação BaseScan
- Detector em Fly.io free tier
- Simulação por 2 semanas com mempool real (mas tx vão pra Sepolia, não mainnet)

### Etapa 3 — Mainnet com cap pequeno
- Deploy mainnet com `MAX_TRADE_ETH=0.1`
- Owner = multisig Safe Wallet
- Monitoramento Tenderly + Discord alerts
- Capital inicial: 0.5 ETH

### Etapa 4 — Scale
- Capital aumentado escalonadamente
- Multi-chain (Arbitrum + Optimism)
- Audit externo Certik

---

## 🗄️ Persistência

### MVP (Fases 0-5)
- **Sem banco.** Tudo em logs estruturados pino → arquivo + stdout
- Estado em memória do detector

### Pós-mainnet (Fase 7+)
- **Neon Postgres** (padrão MAZARI)
- Tabelas:
  - `opportunities_detected` — histórico de oportunidades vistas (mesmo as não executadas)
  - `trades` — todas as txs executadas com profit, gas, blockNumber
  - `liquidations` — posições liquidadas
  - `health_factors_snapshot` — snapshot diário pra análise
- Drizzle ORM
- Dashboards via Grafana ou metabase

---

## 🧪 Testes

### Unit (Solidity, Foundry)
- Cada adapter: 5+ tests cobrindo happy path + edge cases
- Cada strategy: tests com mocks
- ZeusExecutor: invariants (profit obrigatório, kill switch funciona)

### Integration (Solidity, Foundry fork)
- `vm.createFork(BASE_RPC)` pra testar contra DEXs reais
- Simular trade real e verificar profit calculado bate

### Fuzzing (Solidity, Foundry)
- `forge test --fuzz-runs 100000` em funções críticas
- Invariant testing pra propriedades globais

### E2E (TypeScript, vitest)
- Detector + Foundry + anvil local rodando juntos
- Cenário: mempool simulado → detector identifica → contrato executa

---

## 📂 Arquivos relacionados

- [README.md](./README.md)
- [CONTEXT.md](./CONTEXT.md)
- [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md)
- [TODO.md](./TODO.md)
- [CONTRACTS.md](./CONTRACTS.md)
- [CLAUDE.md](./CLAUDE.md)
