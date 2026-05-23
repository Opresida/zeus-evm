# TODO — ZEUS EVM

Lista detalhada do que está pronto e do que falta para **pleno funcionamento** (do estado atual até bot rodando em mainnet Base com capital real).

**Última atualização:** 2026-05-22 (Fases 0-3 concluídas, Fase 4 parcial, Fase 5a deploy testnet concluído)

> Documento vivo. Marcar `[x]` quando concluir, não remover (histórico preservado).

---

## ✅ Concluído

### Fase 0 — Setup inicial (2026-05-22) ✅

- [x] Pasta `C:\Users\user\zeus-evm\` + `git init` + repo `github.com/Opresida/zeus-evm`
- [x] Estrutura monorepo: `contracts/`, `apps/{detector,backtest,monitor}/`, `packages/{chain-config,dex-adapters,strategy,shared-types}/`
- [x] `package.json` root + `pnpm-workspace.yaml` com catalog (viem, vitest, pino, zod, tsx)
- [x] `.gitignore` (Node, Foundry, .env, broadcast/, lockfiles incorretos)
- [x] `.env.example` documentado + `.env` local com chave testnet dedicada
- [x] `contracts/foundry.toml` (solc 0.8.27, via_ir, optimizer 1M runs, yul, fuzz config)
- [x] `contracts/remappings.txt` (OpenZeppelin, Uniswap V3, Aave V3 local, forge-std)
- [x] 7 docs canônicos criados (README, CONTEXT, PROJECT_CONTEXT, ARCHITECTURE, TODO, CONTRACTS, CLAUDE)

### Fase 1 — Smart contracts core (2026-05-22) ✅

- [x] `ZeusExecutor.sol` completo (280 LOCs):
  - [x] Ownable2Step + ReentrancyGuard + Pausable + SafeERC20 + custom errors
  - [x] Kill switch fail-safe (constructor inicia _killed=true)
  - [x] `executeArbitrage(ArbitrageParams)` com validações + circuit breaker maxTradeWei
  - [x] `executeFlashloanArbitrage(asset, amount, params)` + callback `executeOperation`
  - [x] `kill()` / `revive()` / `pause()` / `unpause()` / `setOperator()` / `setMaxTradeWei()` / `rescueToken()`
  - [x] Receive ETH
- [x] Interfaces: `IZeusExecutor`, `IPool` (Aave), `IFlashLoanSimpleReceiver`
- [x] Libraries inline (gas-optimized):
  - [x] `UniswapV3Lib` — SwapRouter02 via `exactInputSingle` (extraData = fee tier)
  - [x] `AerodromeLib` — Router via `swapExactTokensForTokens` (extraData = stable+factory)
- [x] **18 unit tests** + fuzzing config (`forge test --fuzz-runs 100000`)
- [x] **4 fork tests** cross-DEX (UniV3 swap real, multistep, InsufficientProfit revert)
- [x] **5 fork tests** flashloan (Aave V3 real, callback, InvalidCaller, TradeTooLarge)

### Fase 2 — Detector off-chain DRY_RUN (2026-05-22) ✅

- [x] `apps/detector/src/config.ts` — load `.env` + Zod schema (20+ vars, optional* preprocessors)
- [x] `apps/detector/src/logger.ts` — pino structured (JSON em prod, pretty em dev)
- [x] `apps/detector/src/mempool/blockSubscription.ts` — WSS Alchemy + retry + polling fallback
- [x] `packages/chain-config`:
  - [x] BASE_MAINNET (Aave/UniV3/Aerodrome/BaseSwap/Compound/Morpho addresses)
  - [x] BASE_SEPOLIA (Aave V3 + UniV3 — sem Aerodrome em testnet)
  - [x] BASE_TARGET_PAIRS (5 pares: WETH/USDC, cbETH/WETH, USDC/USDT, WETH/AERO, USDC/DAI)
- [x] `packages/dex-adapters`:
  - [x] `quoteUniswapV3` via QuoterV2 (simulateContract)
  - [x] `quoteAerodrome` via Router.getAmountsOut
  - [x] **6 vitest tests** contra Base mainnet (gap UniV3↔Aero validado em WETH/USDC)
- [x] `packages/strategy` (refactored 2026-05-22):
  - [x] `opportunities/crossDex.ts` — findCrossDexArb (N² combos forward+reverse)
  - [x] `opportunities/quoteFanout.ts` — parallel quotes across DEXs
  - [x] `opportunities/filters.ts` — min profit USD, slippage, gas, flashloan fee
  - [x] `executor/txBuilder.ts` — buildArbitrageCalldata + buildFlashloanCalldata
  - [x] `executor/simulator.ts` — eth_call + estimateGas + decode custom errors
  - [x] `executor/abi.ts` — ABI completa ZeusExecutor (funcs, events, errors)
- [x] `apps/detector/src/index.ts` — orquestração: WSS subscribe → scan 5 pares → filter → simulate (opt-in)
- [x] `apps/detector/src/smoke.ts` — script de diagnóstico (config + RPC + balance)

### Fase 3 — Flashloan integration (2026-05-22) ✅

- [x] `executeOperation()` callback Aave V3 com validações caller + initiator + profit
- [x] `executeFlashloanArbitrage()` chamando `IPool.flashLoanSimple`
- [x] Repay automático Aave + fee 0.05% via forceApprove
- [x] Fork tests passando contra Base mainnet
- [x] `simulator.ts` decoda `FlashloanRepayShortfall`, `InsufficientProfit`, `TradeTooLarge`, etc.
- [x] Integração no detector: simula arb após filter pass (sem submeter)

### Fase 4a — Backtest histórico (parcial, 2026-05-22) ✅

- [x] `apps/backtest/src/index.ts` — replay de N blocos com `findCrossDexArb`
- [x] Output JSON estruturado em `apps/backtest/runs/`
- [x] **Resultado: 0 oportunidades em 1000 blocos amostrados (5.5h Base mainnet)**
- [x] Conclusão: cross-DEX em blue chips Base não tem edge real em 2026 (MEV bots dominam)

### Fase 4b — Fork tests do caminho POSITIVO (2026-05-22) ✅

- [x] `contracts/test/fork/ZeusExecutor.profitArb.t.sol`:
  - [x] `test_WalletArb_GeneratesProfit_AfterPriceGap` — wallet arb com gap artificial → PASSA
  - [x] `test_FlashloanArb_GeneratesProfit_AfterPriceGap` — flashloan arb com gap artificial → PASSA
- [x] **Mecânica validada**: contrato executa arb 2-step (UniV3+Aerodrome), calcula profit, transfere pro receiver, repaga Aave
- [x] **27→29 testes Foundry passando**

### Fase 5a — Deploy testnet Base Sepolia (2026-05-22) ✅

- [x] `contracts/script/Deploy.s.sol` — script Foundry com chainId-based config (8453 mainnet, 84532 Sepolia)
- [x] Carteira testnet dedicada criada + fundada via faucet (0.0195 ETH Sepolia)
- [x] ZeusExecutor deployado em Base Sepolia: **`0xe48473d75805886ac4162b1304eab6b8f93c5faa`**
- [x] Contrato verified no Basescan: [sepolia.basescan.org/address/0xe48473...](https://sepolia.basescan.org/address/0xe48473d75805886ac4162b1304eab6b8f93c5faa)
- [x] Estado on-chain validado: isKilled=true (fail-safe), owner=carteira, AAVE_V3_POOL correto Sepolia, maxTradeWei=0.01 ETH
- [x] Bug evitado: 1º deploy pegou Aave mainnet address do `.env` → script corrigido pra usar chainId como source of truth

---

## ❌ Pendente

> "Pleno funcionamento" = bot rodando em mainnet Base com capital real, executando arbitragens em produção.

### 🟡 Fase 4c — Mix A+B em duas trilhas independentes (DECIDIDO 2026-05-23)

**Estratégia escolhida:** Liquidations (A) como motor previsível + Pares Longtail (B) como radar de upside esporádico.

**Princípio de blindagem:** construir e validar cada trilha **isoladamente em fork mainnet** antes de rodarem juntas em produção. Sem cross-contamination de risco.

#### Trilha 1 — Motor de Liquidações (Aave V3)

- [ ] `apps/monitor/src/protocols/aaveV3.ts` — leitura de positions ativas + cálculo HF
- [ ] `apps/monitor/src/healthFactor.ts` — engine HF (calcular off-chain pra evitar gás)
- [ ] `apps/monitor/src/liquidator.ts` — dispara execução quando HF < 1.0
- [ ] Adicionar `executeLiquidation()` no ZeusExecutor:
  - Recebe (user, collateralAsset, debtAsset, debtToCover, useFlashloan)
  - Se useFlashloan: pega flashloan do debtAsset, chama `liquidationCall`, recebe colateral + bonus, swap colateral→debtAsset pra repay, mantém profit
  - Se !useFlashloan: usa saldo próprio do contrato
- [ ] Fork tests com posições reais de Base mainnet (achar HF < 1.05 via subgraph/scan)
- [ ] Documentar protocolos suportados (start: Aave V3, depois Compound III, depois Morpho)
- Edge: 5-10% liquidation bonus, janela 1-3 blocos, não precisa competir em ms

#### Trilha 2 — Radar Longtail/Medium-cap

- [ ] Reescrever `packages/chain-config/src/target-pairs.ts`:
  - Remover blue chips (WETH/USDC, cbETH/WETH, USDC/USDT, USDC/DAI)
  - Adicionar medium-cap Base: DEGEN, BRETT, MOG, HIGHER, AIXBT, MAMO, VIRTUAL, etc
  - Adicionar RWAs conhecidos na Base (a definir lista após pesquisa)
- [ ] Re-rodar backtest 1000 blocos com nova lista — esperar > 0 oportunidades
- [ ] Ajustar `findCrossDexArb` se necessário (slippage maior, size menor pra pools rasos)
- [ ] Adicionar filtro de TVL mínimo do pool (evitar honeypots)
- [ ] Detector continua DRY_RUN — só simular, não submeter ainda
- Edge: 0.5-2% spread esporádico, frequência baixa mas decente

#### Fase de integração (depois das 2 trilhas validadas isoladamente)

- [ ] Detector + Monitor rodando em paralelo, com kill switch independente por trilha
- [ ] Métricas separadas: oportunidades por trilha, profit por trilha, falhas por trilha
- [ ] Decisão: trilha primária = Liquidations, Longtail = adicional

---

### 🔮 Estratégias futuras (Fase 9+, paralelas à validação principal)

Mapeadas pelo Humberto em 2026-05-23 para implementação após Mix A+B estar em produção estável.

#### Estratégia C — Pools de RWA + LSTs

- [ ] Mapear tokens RWA na Base (agricultura sustentável, imobiliário, energia)
- [ ] Mapear LSTs (cbETH, wstETH se existir em Base)
- [ ] Monitor de discrepâncias de preço entre pools RWA/local vs stablecoins/LSTs
- Edge: bots institucionais ignoram (volume baixo + complexidade do ativo subjacente)
- Risco: liquidez muito baixa, slippage alto, due diligence do emissor

#### Estratégia D — Backrunning de baleias (dislocation pós-trade)

- [ ] Mempool listener Alchemy WSS pra pending txs
- [ ] Decoder de calldata pra identificar swaps grandes (>$100k) em DEXs alvo
- [ ] Calculadora de impacto pós-swap em cada pool
- [ ] Submitter prioritário pra entrar no bloco seguinte
- Edge: dislocation transitória (100ms-3s) após trade grande
- Vantagem Base: sem MEV-Boost/Flashbots agressivo como mainnet ETH → jogo é otimização de RPC
- Risco: requer latência baixa, possível concorrência crescendo

#### Estratégia E — Arbitragem ve(3,3) intra-Aerodrome

- [ ] Identificar pares Aerodrome com pools volatile (x*y=k) E stable (k = x³y + xy³) ativos
- [ ] Calcular discrepância entre as duas curvas pro mesmo par
- [ ] Arb intra-DEX (sem cross-DEX, sem competição cross-protocolo)
- Edge: tokens roteados ineficientemente entre pools volatile/stable do Aerodrome
- Vantagem: específico de Base, edge único, requer conhecimento da matemática ve(3,3)

### 🔴 Fase 5b — Testnet observação (2 semanas)

- [ ] Detector apontando pra Sepolia
- [ ] Owner chama `revive()` no contrato (sai do kill state)
- [ ] Owner chama `setOperator(bot_address, true)`
- [ ] Rodar 2 semanas observando comportamento real
- [ ] Coletar bugs / iterar parâmetros

**Critério pra próxima fase:**
- Bot rodou 2 semanas sem revert inesperado
- Kill switch testado e funcional
- Strategy escolhida em 4c mostrou oportunidades em testnet

### 🔴 Fase 6 — Liquidations completas (se opção A escolhida)

Detalhado em Fase 4c opção A acima.

### 🔴 Fase 7 — Deploy mainnet capital pequeno (1 mês de observação)

- [ ] Deploy `ZeusExecutor` em Base mainnet
- [ ] Multisig Safe Wallet como owner
- [ ] Capital inicial: **0.5 ETH** (~$1.5k)
- [ ] `MAX_TRADE_ETH=0.1` (cap baixo pra observação)
- [ ] Tenderly alerts + Discord webhook ativos
- [ ] Rodar 2-4 semanas observando
- [ ] Análise semanal: PnL, drawdown, padrões

**Critério pra escalar:**
- 4 semanas sem perda significativa
- PnL líquido positivo
- Sem incidentes operacionais

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

- [ ] **Trilha 1 (Liquidações)** — construir apps/monitor + executeLiquidation no contrato
- [ ] **Trilha 2 (Radar Longtail)** — reescrever target-pairs com medium-cap Base + RWAs

---

## ⏸️ Pausado / aguardando decisão do Humberto

- [x] ~~Decidir quando fazer push pro GitHub~~ → push contínuo desde Fase 1
- [x] ~~Provider de RPC primário~~ → **dRPC** (210M CU/mês free) + Alchemy fallback
- [x] ~~Estratégia de edge~~ → **Mix A+B em duas trilhas independentes** (decidido 2026-05-23)
- [ ] **Ordem de execução das trilhas**: Trilha 1 primeiro / Trilha 2 primeiro / paralelo
- [ ] Lista concreta de tokens RWA + LSTs em Base (pesquisa pra Trilha 2)
- [ ] Definir multisig provider (Safe Wallet vs alternativa) — antes de Fase 7
- [ ] Definir capital inicial concreto pra Fase 7
- [ ] Decidir se Neon Postgres entra ou só logs por enquanto
- [ ] Definir audit provider (Certik vs Trail of Bits vs OpenZeppelin) — antes de Fase 8

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
| 2026-05-22 | Setup inicial (Fase 0): monorepo pnpm + Foundry + 7 docs canônicos |
| 2026-05-22 | Fase 1: ZeusExecutor + UniV3Lib + AerodromeLib + 22 testes passando |
| 2026-05-22 | Fase 2: Detector DRY_RUN — dex-adapters + opportunities + WSS subscribe |
| 2026-05-22 | Fase 3: Flashloan Aave V3 + TxBuilder + Simulator + integração detector |
| 2026-05-22 | Track A: Deploy ZeusExecutor em Base Sepolia (`0xe48473...`) + verified Basescan |
| 2026-05-22 | Track B: Refactor `packages/strategy` + `apps/backtest` + fork tests profitArb (29/29) |
| 2026-05-23 | Decisão Fase 4c: **Mix A+B em duas trilhas** (Liquidações + Longtail) + adicionadas 3 estratégias futuras (RWA/LST, Backrunning baleias, Aerodrome ve(3,3)) |
