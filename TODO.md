# TODO — ZEUS EVM

Lista detalhada do que está pronto e do que falta para **pleno funcionamento** (do estado atual até bot rodando em mainnet Base com capital real).

**Última atualização:** 2026-05-22

> Documento vivo. Marcar `[x]` quando concluir, não remover (histórico preservado).

---

## ✅ Concluído

### Fase 0 — Setup inicial (2026-05-22)

- [x] Pasta `C:\Users\user\zeus-evm\` criada
- [x] `git init` na raiz (sem push pro GitHub ainda)
- [x] Estrutura monorepo: `contracts/`, `apps/{detector,monitor}/`, `packages/{chain-config,dex-adapters,shared-types}/`, `scripts/`, `docs/refs/`
- [x] `package.json` root com workspace scripts (build, typecheck, contracts:build, contracts:test)
- [x] `pnpm-workspace.yaml` com catalog de versões (viem, vitest, pino, zod, tsx)
- [x] `.gitignore` (Node, Foundry, .env, lockfiles incorretos)
- [x] `.env.example` com 20+ variáveis documentadas (RPC, wallet, estratégia, flashloan, monitoring)
- [x] `contracts/foundry.toml` (solc 0.8.27, via_ir, optimizer 1M runs, fuzz config)
- [x] `contracts/remappings.txt` (OpenZeppelin, Uniswap V2/V3, Aave V3, forge-std)
- [x] Stub `contracts/src/ZeusExecutor.sol` com structs `SwapStep`, `ArbitrageParams`, interface `IZeusExecutor`, eventos, custom errors
- [x] Stub `contracts/test/ZeusExecutor.t.sol` pronto pra forks
- [x] 7 docs canônicos criados (README, CONTEXT, PROJECT_CONTEXT, ARCHITECTURE, TODO, CONTRACTS, CLAUDE)

---

## ❌ Pendente para pleno funcionamento

> "Pleno funcionamento" = bot rodando em mainnet Base com capital real, executando arbitragens em produção.

### 🟡 Fase 0 — Resto do setup

- [ ] Stubs do detector TS (`apps/detector/src/index.ts`, `config.ts`, `logger.ts`)
- [ ] Stubs do monitor TS (`apps/monitor/src/index.ts`)
- [ ] Package `@zeus-evm/chain-config` com addresses Base mainnet (Aave V3 Pool, Uniswap V3 Factory, Aerodrome, BaseSwap, USDC, WETH)
- [ ] Package `@zeus-evm/shared-types` com tipos espelhando structs Solidity
- [ ] Package `@zeus-evm/dex-adapters` (stub)
- [ ] `pnpm install` na raiz, validar workspaces resolvem
- [ ] `forge install` das libs OpenZeppelin, Uniswap V3, Aave V3
- [ ] `forge build` passa
- [ ] `forge test` passa (placeholder test)
- [ ] `pnpm typecheck` passa em todos workspaces

---

### 🔴 Fase 1 — Smart contracts core (3-4 dias)

#### ZeusExecutor.sol completo
- [ ] Constructor com `owner`, `MAX_TRADE_ETH`, kill switch defaults
- [ ] `Ownable2Step` + `ReentrancyGuard` + `Pausable`
- [ ] `executeArbitrage(ArbitrageParams)`:
  - [ ] Validações (not killed, msg.sender authorized, params válidos)
  - [ ] Loop sobre SwapStep[] chamando adapters
  - [ ] Cálculo de profit final
  - [ ] Validação `profit >= minProfitWei`
  - [ ] Transfer pra `profitReceiver`
  - [ ] Emit `ArbitrageExecuted`
- [ ] `kill()` / `revive()` (só owner)
- [ ] `rescueToken()` (só owner)
- [ ] Receive ETH (`receive()` payable)
- [ ] Testes unitários (90%+ coverage)
- [ ] Fuzz tests `forge test --fuzz-runs 100000`

#### Adapters DEX (start: Uniswap V3 + Aerodrome)
- [ ] `interfaces/IDexAdapter.sol` — interface comum
- [ ] `adapters/UniswapV3Adapter.sol`:
  - [ ] `swap(SwapStep)` chamando `SwapRouter.exactInputSingle`
  - [ ] Support a fee tiers 0.05%, 0.3%, 1%
  - [ ] Approve tokens automaticamente
- [ ] `adapters/AerodromeAdapter.sol`:
  - [ ] `swap(SwapStep)` pra pools stable + volatile
  - [ ] Decode `extraData` pra identificar tipo de pool
- [ ] Testes contra fork de Base mainnet

#### Strategy WalletArb
- [ ] `strategies/WalletArbStrategy.sol`:
  - [ ] Wrapper sobre `executeArbitrage` com defaults pra modo wallet
- [ ] Tests

---

### 🔴 Fase 2 — Detector off-chain (4-5 dias)

#### Config e infra
- [ ] `apps/detector/src/config.ts` — load `.env` + valida com zod
- [ ] `apps/detector/src/logger.ts` — pino structured logs
- [ ] `apps/detector/src/chains.ts` — chain client setup (publicClient + walletClient)

#### Mempool monitoring
- [ ] Subscribe pending txs via Alchemy WSS
- [ ] Filtrar txs relevantes (swap em DEXs alvo)
- [ ] Decoder de calldata pra identificar swap parameters (token in/out, amount)

#### Pricing engine
- [ ] Read Uniswap V3 pool state (`slot0`, `liquidity`) on-chain
- [ ] Read Aerodrome pool state
- [ ] Quoter para simular swap output
- [ ] Aggregator pra comparar preços entre DEXs

#### Opportunity calculator
- [ ] `opportunities/crossDex.ts` — detecta arb cross-DEX
- [ ] `opportunities/triangular.ts` — detecta ciclos intra-Uniswap V3 entre fee tiers
- [ ] `opportunities/filters.ts` — min profit, max slippage, max gas

#### Tx builder + submitter
- [ ] `executor/txBuilder.ts` — codifica `ArbitrageParams`
- [ ] `executor/simulator.ts` — `eth_call` antes de enviar
- [ ] `executor/submitter.ts` — envia tx, espera receipt, decodifica evento

#### Monitoring
- [ ] `monitoring/metrics.ts` — coleta success_rate, avg_landed_time_ms, profit
- [ ] `monitoring/alerts.ts` — Discord webhook em eventos críticos (loss, error, kill)

---

### 🔴 Fase 3 — Flashloan integration (2-3 dias)

- [ ] Adicionar `executeOperation()` no ZeusExecutor (callback Aave V3)
- [ ] `executeFlashloanArbitrage(asset, amount, params)`:
  - [ ] Chama `IPool(aave).flashLoanSimple(...)`
  - [ ] Aave call back `executeOperation`
  - [ ] Garante repay com fee
- [ ] Tests com fork Base — Aave V3 Pool real
- [ ] Detector: nova rota `executor/submitFlashloan.ts`
- [ ] Comparar profitabilidade: wallet-arb vs flashloan-arb pra mesma oportunidade

---

### 🔴 Fase 4 — Backtest contra fork (2-3 dias)

- [ ] `scripts/simulate.ts` — replay histórico de blocos contra forks
- [ ] Coleta dados: 1 mês de blocos Base mainnet
- [ ] Roda detector com data histórico simulado
- [ ] Métricas: oportunidades vistas vs capturadas vs lucrativas
- [ ] Análise: PnL teórico, drawdown, success rate
- [ ] Decisão: estratégia tem edge? Quais parâmetros tunar?

**Critério de aprovação para próxima fase:**
- Win rate > 60% out-of-sample
- Profit médio > custo (gas + flashloan fee) com margem
- Pelo menos 50 oportunidades capturáveis por dia

---

### 🔴 Fase 5 — Testnet Base Sepolia (2 semanas)

- [ ] Deploy `ZeusExecutor` em Sepolia via `forge script DeployExecutor.s.sol --rpc-url $SEPOLIA_RPC --broadcast --verify`
- [ ] Faucet ETH testnet
- [ ] Detector apontando pra Sepolia
- [ ] **2 semanas rodando** (com mempool de mainnet simulado se possível)
- [ ] Análise diária dos resultados
- [ ] Iteração nos parâmetros (min profit, max slippage)
- [ ] Coletar bugs

**Critério pra próxima fase:**
- Bot rodou 2 semanas sem revert inesperado
- Métricas estáveis e dentro do esperado pelo backtest
- Kill switch testado e funcional

---

### 🔴 Fase 6 — Liquidations (1 semana)

- [ ] `monitor/protocols/aaveV3.ts` — leitura de positions, cálculo HF
- [ ] `monitor/protocols/compoundV3.ts`
- [ ] `monitor/protocols/morpho.ts`
- [ ] `monitor/healthFactor.ts` — engine de cálculo
- [ ] `monitor/liquidator.ts` — dispara `liquidatePosition` no ZeusExecutor
- [ ] `strategies/LiquidatorStrategy.sol`
- [ ] Tests com fork
- [ ] Testnet 1 semana

---

### 🔴 Fase 7 — Deploy mainnet capital pequeno (1 mês de observação)

- [ ] Deploy `ZeusExecutor` em Base mainnet
- [ ] Multisig Safe Wallet como owner
- [ ] Capital inicial: **0.5 ETH** (~$1.5k)
- [ ] `MAX_TRADE_ETH=0.1` (cap baixo pra observação)
- [ ] Tenderly alerts configurados
- [ ] Discord webhook ativo
- [ ] Rodar 2-4 semanas observando
- [ ] Análise semanal: PnL, drawdown, padrões

**Critério pra escalar:**
- 4 semanas sem perda significativa
- PnL líquido positivo
- Sem incidentes operacionais

---

### 🔴 Fase 8 — Audit externo (1-2 semanas)

- [ ] Selecionar audit provider (Certik / Trail of Bits / OpenZeppelin Defender / Halborn)
- [ ] Preparar repo pra audit (código limpo, NatSpec completo, testes 95%+ coverage)
- [ ] Submit code freeze
- [ ] Receber relatório
- [ ] Corrigir findings (high/critical mandatórios, medium recomendados)
- [ ] Re-audit dos fixes
- [ ] Publicação do relatório

**Custo estimado:** US$ 4.200 (Certik — alinhado com Etapa 2 do pacote Enterprise Nortoken) a US$ 25k+ (Trail of Bits).

---

### 🔴 Fase 9 — Scale (indefinido)

- [ ] Capital aumentado escalonadamente (post-audit)
- [ ] Multi-chain: Arbitrum One
- [ ] Multi-chain: Optimism
- [ ] Bug bounty Immunefi (US$ 5-10k pool)
- [ ] Dashboard de monitoramento (Grafana?)
- [ ] Otimizações de gas baseadas em produção
- [ ] Considerar self-hosted Reth pra latência

---

## 🟡 Melhorias técnicas (paralelo / pós-Fase 7)

### Performance
- [ ] Otimização extrema de calldata size (impacta gas)
- [ ] Considerar MultiCall pra reads em batch
- [ ] Pre-aprovação de tokens pra adapters

### Qualidade
- [ ] Coverage 95%+ em contratos
- [ ] Coverage 80%+ em TS
- [ ] Property-based tests com Echidna (alternativa ao Foundry fuzz)
- [ ] Static analysis: Slither + Mythril em CI

### CI/CD
- [ ] GitHub Actions:
  - [ ] Lint + typecheck em PR
  - [ ] `forge test` em PR
  - [ ] Slither em PR
  - [ ] Deploy testnet automático em main
- [ ] Pre-commit hooks (`forge fmt`, lint)

### Observabilidade
- [ ] Tenderly alerts customizados
- [ ] Forta Network (free) detect agents
- [ ] OpenZeppelin Defender Sentinel
- [ ] Métricas exportadas pra Grafana

### Documentação
- [ ] Runbook de incident response
- [ ] Audit findings publicados
- [ ] API docs auto-geradas (typedoc)
- [ ] Bug bounty config Immunefi

---

## 🟢 Pequenos itens / polimento

- [ ] Favicon e meta tags se algum dia tiver dashboard
- [ ] Adicionar badges no README (build status, coverage, last deploy)
- [ ] CHANGELOG.md
- [ ] CONTRIBUTING.md (mesmo sendo projeto privado, padrão é bom)

---

## 🔄 Em andamento

- [x] Setup inicial e docs canônicos (Fase 0 quase completa)

---

## ⏸️ Pausado / aguardando decisão do Humberto

- [ ] Decidir quando fazer push pro GitHub (agora vs depois do MVP)
- [ ] Decidir provider de mempool (Alchemy vs Blocknative vs Reth self-hosted)
- [ ] Definir multisig provider (Safe Wallet vs alternativa)
- [ ] Definir capital inicial concreto pra Fase 7
- [ ] Decidir se Neon Postgres entra ou só logs por enquanto
- [ ] Definir audit provider (Certik vs Trail of Bits vs OpenZeppelin)

---

## 🐛 Bugs conhecidos / riscos abertos

- [ ] Sem audit ainda — capital alto = risco alto
- [ ] Sem testes com fork mainnet ainda — comportamento real desconhecido
- [ ] Sem MEV protection — outras bots podem nos sandwich
- [ ] Single private key — futuro: MPC ou hardware wallet

---

## 📈 Métricas de sucesso (planejado)

Quando estiver em produção, monitorar:

- **Success rate de tx** (norte: > 70%)
- **Avg landed time** (norte: < 2 blocos = < 4s)
- **Profit per trade** (norte: > $5 líquido após gas+fee)
- **Oportunidades capturáveis/dia** (norte: > 10)
- **Drawdown máximo** (limite hard: 25%)
- **Capital efficiency** (profit/capital deployed)

---

## 📝 Histórico de mudanças

| Data | Mudança principal |
|---|---|
| 2026-05-22 | Setup inicial: monorepo pnpm + Foundry + 7 docs canônicos + stub ZeusExecutor |
