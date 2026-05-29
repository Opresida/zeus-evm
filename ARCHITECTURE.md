# ARCHITECTURE — ZEUS EVM

Estrutura de pastas, fluxos de dados e decisões arquiteturais.

---

> ## 🔄 ESTADO ATUAL (2026-05-29) — o que mudou desde o snapshot abaixo
>
> Este doc descreve fluxos que **continuam válidos conceitualmente**, mas a implementação evoluiu.
> Mapeamento do que está desatualizado no texto antigo:
>
> | No texto antigo | Estado atual |
> |---|---|
> | `ZeusExecutor v6` (1 contrato monolítico) | **4 contratos v8 (split por EIP-170):** BribeManager + ZeusLiquidator (Aave/Compound/Morpho) + ZeusArbExecutor (arb/backrun) + ZeusMoonwellLiquidator |
> | 3 protocolos (Aave/Compound/Morpho) | **5:** + Seamless (fork Aave) + Moonwell (fork Compound V2) |
> | Cross-DEX "radar passivo / dead-end" | **Motor 2 = radar MIS** (`apps/mis-scanner`): pricing local + multicall + derivação on-chain + flash sizing + gate de profundidade. Ranqueia por persistência |
> | Backrun "planejado" | **`apps/backrun-engine` construído** (planner + bribe + bundling); falta mempool premium |
> | Chains: Base/Arb/OP (+Avax planejado) | **Code-ready: Base/Arb/OP/Polygon/Avalanche** |
> | DEXs: UniV3 · Aerodrome | + Velodrome (OP) + **Trader Joe LB** (Avalanche, AMM por bins) |
> | Fork tests | **34/34 verdes** via Alchemy, incl. prova de LUCRO dos 3 motores (`test/fork/MotorsProfit.fork.t.sol`) |
>
> Os fluxos 1/2/3 abaixo (executeArbitrage / executeFlashloanArbitrage / liquidation) continuam corretos —
> só estão hoje distribuídos entre ZeusArbExecutor e ZeusLiquidator em vez de um único ZeusExecutor.

## 🧭 Visão geral

ZEUS EVM é um **monorepo pnpm** com 3 camadas:

1. **`contracts/`** — Foundry project com smart contracts on-chain (Solidity)
2. **`apps/`** — Aplicações off-chain (TypeScript) que disparam transações
3. **`packages/`** — Bibliotecas compartilhadas entre apps

```
┌────────────────────────────────────────────────────────────────────┐
│                    ZEUS EVM (monorepo) — snapshot 2026-05-25       │
└────────────────────────────────────────────────────────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────┐  ┌────────────────────┐  ┌──────────────────────┐
│   contracts/    │  │       apps/        │  │    packages/         │
│   (Solidity)    │  │    (TypeScript)    │  │   (shared TS)        │
│                 │  │                    │  │                      │
│ ZeusExecutor v6 │  │ detector (radar)   │  │ chain-config         │
│  + 5 execute*   │  │ backtest           │  │ dex-adapters         │
│    funcs:       │  │ monitor (DRY_RUN)  │  │ strategy             │
│  - Arbitrage    │  │ liquidator (3      │  │ aave-discovery NOVO  │
│  - Flashloan    │  │   modos: dryrun /  │  │ shared-types         │
│  - LiqAave      │  │   testnet /        │  │                      │
│  - LiqCompound  │  │   mainnet)         │  │                      │
│  - LiqMorpho    │  │                    │  │                      │
└─────────────────┘  └────────────────────┘  └──────────────────────┘
        │                       │                       │
        └────────── interagem via viem + ABI ───────────┘
                            │
                            ▼
              ┌──────────────────────────────┐
              │  Mainnet chains (após Fase7) │
              │                              │
              │  Base (Coinbase L2)          │
              │  Arbitrum One                │
              │  Optimism                    │
              │  Avalanche (planejado)       │
              │                              │
              │  Protocolos:                 │
              │   Aave V3 · Compound III ·   │
              │   Morpho Blue                │
              │  DEXs: UniV3 · Aerodrome     │
              └──────────────────────────────┘
```

### Pipeline do `apps/liquidator` (Sprint 1 + 2 + Backend Completo)

```
┌──────────────────────────────────────────────────────────────────┐
│  PIPELINE PRE-DISPATCH GATES (5 fusíveis ortogonais)             │
├──────────────────────────────────────────────────────────────────┤
│  Gate 1: PnL Tracker        — kill switch se loss 24h ≥ $X       │
│  Gate 2: Failure Tracker    — cooldown se N falhas seguidas      │
│  Gate 3: Gas Reserve        — bloqueia se balance < critical     │
│  Gate 4: Position Dedup     — bloqueia re-submit por TTL         │
│  Gate 5: QuoterV2           — sanity (calculator não funciona)   │
└──────────────────────────────────────────────────────────────────┘
                              │ (todos verde)
                              ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ 1. DISCOVERY │ ──→ │ 2. CALCULATOR│ ──→ │ 3. SIMULATOR │
└──────────────┘     └──────────────┘     └──────────────┘
  subgraph              binary search        eth_call
  + Multicall3          10+5 samples         valida revert
  HF batch              + UniV3 QuoterV2     + decoda erro
  resolve par           + slippage check     + estima gas
  (Aave) /              + cache TTL 60s
  event scan
  (Compound)
                              │
                              ▼
                  ┌─────────────────────────┐
                  │  Gate 6: STALE CHECK    │  ← NOVO (gap #8)
                  │  re-checa HF on-chain   │
                  │  (só em testnet/mainnet)│
                  └─────────────────────────┘
                              │
                              ▼
                  ┌──────────────────────────┐
                  │ 4. DISPATCHER             │
                  │  - GasOracle EIP-1559     │  ← NOVO (gap #5)
                  │  - markPending (dedup)    │
                  │  - sendTransaction        │
                  │  - waitForReceipt         │
                  └──────────────────────────┘
                              │
                              ▼
                  ┌──────────────────────────┐
                  │ 5. POST-PROCESS           │
                  │  - Event decoder          │
                  │  - PnL tracker record     │  → JSONL persist
                  │  - Failure tracker record │
                  │  - Dedup markConfirmed    │
                  │  - EventBus emit          │  → Discord/webhook
                  └──────────────────────────┘
```

**6 trackers internos rodando em paralelo:**
- PnL Tracker (rolling 24h + auto kill on-chain)
- Failure Tracker (cooldown após N falhas)
- Position Dedup (TTL por chave composta)
- Gas Reserve (balance monitor + alertas)
- Gas Oracle (EIP-1559 cache por bloco)
- EventBus (emit pra Discord/Generic/futuro WebSocket)

**3 modos operacionais:**
- `dryrun`: pipeline completo SEM submit (alimenta cache + LOGA decisions teóricas)
- `testnet`: submit em chains Sepolia
- `mainnet`: submit em chains mainnet (requer checklist obrigatório)

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
│   ├── foundry.toml            # solc 0.8.27 + via_ir + 1M runs + yul + 4 chains aliases
│   ├── remappings.txt
│   ├── src/
│   │   ├── ZeusExecutor.sol            # Hot path principal (~590 LOCs) — 5 funções execute*:
│   │   │                               #   executeArbitrage, executeFlashloanArbitrage,
│   │   │                               #   executeLiquidation (Aave V3),
│   │   │                               #   executeCompoundLiquidation (Comet),
│   │   │                               #   executeMorphoLiquidation (Morpho Blue)
│   │   ├── libraries/
│   │   │   ├── UniswapV3Lib.sol        # inline adapter SwapRouter02
│   │   │   └── AerodromeLib.sol        # inline adapter Aerodrome Router
│   │   └── interfaces/
│   │       ├── IZeusExecutor.sol       # SwapStep, ArbitrageParams, LiquidationParams,
│   │       │                           # CompoundLiquidationParams, MorphoLiquidationParams,
│   │       │                           # OperationType enum, errors customizados
│   │       ├── aave/                   # IPool, IFlashLoanSimpleReceiver
│   │       ├── compound/IComet.sol     # absorb, buyCollateral, isLiquidatable, quoteCollateral
│   │       └── morpho/IMorpho.sol      # liquidate, position, idToMarketParams, MarketParams
│   ├── test/
│   │   ├── ZeusExecutor.t.sol            # 18 unit tests (constructor, kill switch, access)
│   │   ├── ZeusExecutor.fixes.t.sol      # 11 testes adversariais (Audit Pass 2 fixes)
│   │   └── fork/                         # fork tests Base mainnet (24 tests)
│   │       ├── ZeusExecutor.fork.t.sol           # cross-DEX swaps reais
│   │       ├── ZeusExecutor.flashloan.t.sol      # Aave V3 flashloan
│   │       ├── ZeusExecutor.profitArb.t.sol      # arb LUCRATIVO com gap artificial
│   │       ├── ZeusExecutor.liquidation.t.sol    # Aave V3 liquidation ($8.643 profit)
│   │       ├── ZeusExecutor.compoundLiquidation.t.sol  # Compound III liquidation
│   │       └── ZeusExecutor.morphoLiquidation.t.sol    # Morpho Blue liquidation
│   ├── script/
│   │   └── Deploy.s.sol                # chainId-based: 6 chains suportadas (Base/Arb/OP × mainnet+sepolia)
│   └── lib/                            # forge install deps (gitignored)
│
├── apps/
│   │
│   ├── detector/               # ═══ DETECTOR OFF-CHAIN (orquestração) ═══
│   │   ├── package.json        # @zeus-evm/detector
│   │   └── src/
│   │       ├── index.ts        # main loop: WSS subscribe → scan → filter → simulate
│   │       ├── smoke.ts        # script de diagnóstico (config + RPC + balance)
│   │       ├── config.ts       # Zod schema + load .env do monorepo root
│   │       ├── logger.ts       # pino structured (JSON em prod)
│   │       └── mempool/
│   │           └── blockSubscription.ts  # WSS Alchemy + retry + polling fallback
│   │
│   ├── backtest/               # ═══ REPLAY HISTÓRICO ═══
│   │   ├── package.json        # @zeus-evm/backtest
│   │   ├── src/index.ts        # replay N blocos com findCrossDexArb (paralelo)
│   │   └── runs/               # outputs JSON (gitignored)
│   │
│   ├── monitor/                # ═══ DRY_RUN MONITOR (3 protocolos) ═══
│   │   ├── package.json        # @zeus-evm/monitor
│   │   └── src/
│   │       ├── index.ts                  # discovery loops Aave + Compound + Morpho
│   │       ├── chainContext.ts            # resolve por CHAIN_ID
│   │       ├── healthFactor.ts            # HF check via Multicall3
│   │       └── protocols/
│   │           ├── aaveV3.ts              # subgraph candidates
│   │           ├── compoundV3.ts          # event scan chunked (free tier safe)
│   │           └── morpho.ts              # subgraph Messari-format (schema-fixed 2026-05-25)
│   │
│   └── liquidator/             # ═══ LIQUIDATOR (Sprint 1 + 2 + Backend completo) ═══
│       ├── package.json        # @zeus-evm/liquidator
│       └── src/
│           ├── index.ts                  # boot + discoveryTick + processOpportunity
│           ├── config.ts                  # 3 modos + thresholds + 6 trackers config
│           ├── chainContext.ts            # client + wallet opcional
│           ├── pipeline.ts                # runAavePipeline + runCompoundPipeline (6 gates)
│           ├── dispatcher.ts              # EIP-1559 + waitForReceipt + event emit
│           ├── pnlTracker.ts              # gap #1: rolling 24h + auto kill switch
│           ├── failureTracker.ts          # gap #2: cooldown após N falhas seguidas
│           ├── positionDedup.ts           # gap #3: pending/confirmed/failed por position
│           ├── gasReserveTracker.ts       # gap #4: balance monitor + 2 thresholds
│           ├── gasOracle.ts               # gap #5: EIP-1559 maxFee/priority + cache
│           ├── eventBus.ts                # gap #7: emit/subscribe interno
│           ├── events.ts                  # gap #7: 11 tipos canônicos ZEUS-typed
│           ├── staleCheck.ts              # gap #8: re-check HF on-chain pre-submit
│           ├── eventDecoder.ts            # decode 5 eventos *Executed + delta
│           ├── priceUtils.ts              # wei→"$12.45" humano + USD estimate
│           ├── slippageCache.ts           # cache TTL 60s pra UniV3 quotes
│           ├── alerting/
│           │   ├── discordSink.ts         # gap #7: formata embeds Discord
│           │   └── genericWebhookSink.ts  # gap #7: POST JSON raw pra qualquer URL
│           └── protocols/
│               ├── aave/                  # calculator (binary search) + simulator + builder
│               └── compound/              # ABI + cometCache + discovery + calc + sim + builder
│
├── packages/
│   │
│   ├── chain-config/           # ═══ CONFIGURACOES POR CHAIN ═══
│   │   ├── package.json        # @zeus-evm/chain-config
│   │   └── src/
│   │       ├── base.ts / arbitrum.ts / optimism.ts   # mainnet configs
│   │       ├── base-sepolia.ts / arbitrum-sepolia.ts / optimism-sepolia.ts
│   │       ├── target-pairs.ts             # 5 pares: WETH/USDC, cbETH/WETH, ...
│   │       ├── types.ts                    # ChainConfig type
│   │       └── index.ts                    # CHAINS registry
│   │
│   ├── dex-adapters/           # ═══ ADAPTERS TS (OFF-CHAIN PRICING) ═══
│   │   ├── package.json        # @zeus-evm/dex-adapters
│   │   ├── src/
│   │   │   ├── uniswapV3.ts                # quoteUniswapV3 via QuoterV2
│   │   │   ├── aerodrome.ts                # quoteAerodrome via Router.getAmountsOut
│   │   │   ├── types.ts                    # Quote, DexType, QuoteResult
│   │   │   └── index.ts
│   │   └── tests/                          # 6 vitest tests contra Base mainnet
│   │
│   ├── strategy/               # ═══ LÓGICA DE DETECÇÃO + EXECUÇÃO ═══
│   │   ├── package.json        # @zeus-evm/strategy
│   │   └── src/
│   │       ├── opportunities/
│   │       │   ├── crossDex.ts             # findCrossDexArb (radar passivo)
│   │       │   ├── quoteFanout.ts          # parallel quotes across DEXs
│   │       │   └── filters.ts              # min profit, slippage, gas, flashloan fee
│   │       ├── executor/
│   │       │   ├── txBuilder.ts            # buildArbitrageCalldata + buildFlashloanCalldata
│   │       │   ├── simulator.ts            # eth_call + estimateGas + decode errors
│   │       │   └── abi.ts                  # ABI completa ZeusExecutor (Aave + Compound + Morpho)
│   │       └── index.ts                    # re-exports
│   │
│   ├── aave-discovery/         # ═══ SHARED DISCOVERY PACKAGE (NOVO 2026-05-25) ═══
│   │   ├── package.json        # @zeus-evm/aave-discovery
│   │   └── src/
│   │       ├── abi.ts                      # ABIs Pool/PoolDataProvider/AddressesProvider
│   │       ├── logger.ts                   # LoggerLike interface pino-compatible
│   │       ├── types.ts                    # AaveCandidate + AaveLiquidatablePosition
│   │       ├── reserves.ts                 # buildAaveReservesCache (1x boot)
│   │       ├── discovery.ts                # pipeline subgraph→Multicall3→par dominante
│   │       └── index.ts                    # re-exports
│   │
│   └── shared-types/           # ═══ TIPOS COMPARTILHADOS ═══
│       ├── package.json        # @zeus-evm/shared-types
│       └── src/
│           ├── swap.ts                 # SwapStep, ArbitrageParams (mirror Solidity)
│           └── index.ts
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
