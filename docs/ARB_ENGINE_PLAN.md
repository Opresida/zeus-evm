# ZEUS EVM — Plano do Motor de ARB (Cross-DEX + Triangular) + espelhamento de inteligência

> Resposta precisa à pergunta: **removendo da equação o que é inevitável (MAIN, infra, gás,
> mempool do Motor 3), a nível de SOFTWARE — conexões, inteligência, processamento e leitura de
> dados — o que falta para CADA motor funcionar bem e competir de fato?**
>
> Princípio: ZEUS o mais **autônomo e auto-calibrável** possível em todos os motores. O milésimo de
> segundo decide; planejamento sem pontas soltas é parte de vencer a corrida.

---

## 1. Estado por motor (nível de software, infra removida da equação)

| Eixo | Motor 1 (Liquidator) | Motor 2 (MIS / Arb) | Motor 3 (Backrun) |
|---|---|---|---|
| **Detecção** | ✅ 5 protocolos, on-chain + subgraph (resiliente) | ✅ cross-DEX 2-leg + flash sizing + persistência · ❌ **sem triangular** | ✅ cross-DEX pós-whale |
| **Execução** | ✅ pipeline + dispatcher + flashloan 0% | ❌ **NENHUMA** (só observa) | ✅ pipeline + dispatcher + flashloan 0% + bribe |
| **Competidores** (registry/scanner/market-bribe) | ✅ | ❌ **nada** | ✅ |
| **PnL** (reconciler/aggregator/drift) | ✅ completo | ❌ **nada** | 🟡 só reconciler (falta aggregator + drift) |
| **Falhas** (collector + post-mortem) | ✅ collector + CompetitorResolver + BlockPosition | ❌ **nada** | 🟡 só collector (falta post-mortem) |
| **EV gate / scoring** | ✅ `liquidationEdgeGate` (OEV-aware) | ❌ **só ranqueia por persistência, sem EV** | ✅ `scoreBackrunOpportunity` (competitor-aware) |
| **Auto-calibração** (adaptiveThresholds) | ✅ loop 600s | ❌ **nada** | ✅ loop 600s |
| **EventBus + EventIngester** | ✅ | ❌ (grava só `mis_observed` direto, write-only) | ✅ |
| **/metrics + Grafana** | ✅ | ✅ (tem o melhor exporter de dimensão) | ✅ |

### Veredito honesto por motor (a resposta precisa)

- **Motor 1 — completo a nível de software.** Não falta NADA além de infra/MAIN/audit. É o
  padrão-ouro que os outros têm que alcançar.
- **Motor 3 — ~90%.** Falta espelhar **PnlAggregator + CalibrationDriftTracker** (calibração/alarme)
  e o **post-mortem** (CompetitorResolver + BlockPositionTracker = "quem ganhou a corrida do backrun").
  Com isso fica no nível do Motor 1. (Mempool é infra, fora da equação.)
- **Motor 2 — ~25%.** Rico em **detecção**, pobre em **execução e inteligência**. É onde mora quase
  todo o trabalho: (a) não executa nada, (b) não vê competidor, (c) não reconcilia PnL, (d) não tem
  EV gate nem auto-calibração, (e) **não enxerga triangular**. É um radar isolado do loop de inteligência.

**Resumo de uma linha:** *Motor 1 está pronto; Motor 3 está a 2 peças de pronto; Motor 2 precisa
ganhar execução + toda a camada de inteligência que já construímos + visão triangular.*

---

## 2. O que JÁ existe e vamos REUSAR (não reconstruir)

A boa notícia: a fundação está pronta. Quase tudo é **conexão**, não código novo.

- **Contrato:** `ZeusArbExecutor.executeFlashloanArbitrage` → `_executeSwaps(SwapStep[])` itera **N
  steps** (`contracts/src/ZeusArbExecutor.sol:412`). **Triangular já é executável on-chain** (3 steps).
- **Detecção/cotação:** `findCrossDexArb` + `quoteFanout` (`packages/strategy/src/opportunities/`),
  quoters UniV3/Aero/TraderJoe (`packages/dex-adapters`).
- **Filtro/EV:** `filterOpportunity` + `scoreOpportunity` (`packages/execution-utils/src/scoring`).
- **Build/simulate:** `buildFlashloanCalldata` (**já com o seletor de flashloan 0% da Fase 3**) +
  `simulateArbitrage` (`packages/strategy/src/executor`).
- **Dispatcher padrão:** `apps/backrun-engine/src/dispatcher.ts` (`dispatchBackrun`) — molde pronto.
- **Inteligência inteira:** todos os componentes já existem em `@zeus-evm/execution-utils` (foi o que
  ligamos no Motor 1/3). Para o Motor 2 é **instanciar + conectar**, não criar.

**Lacunas reais (código novo):** (1) adaptador `InefficiencyObservation → CrossDexOpportunity`;
(2) re-cotação no dispatch (freshness); (3) generalizar `buildSwapSteps` de 2 → N legs;
(4) **detecção triangular** (grafo + busca de ciclos); (5) config de execução do MIS (wallet/gates).

---

## 3. Plano faseado

> Mesmo padrão dos fixes: uma fase por vez, typecheck + testes verdes em cada, commits isolados,
> reuso máximo. Cada fase deixa o motor mais autônomo. Em DRY_RUN fica dormente/observando; pronto
> pra MAIN+TX.

### PARTE A — Motor 2 vira motor de EXECUÇÃO cross-DEX (2-leg)

- **A1 — Adaptador observação→oportunidade.** `InefficiencyObservation` + `PoolGroup` →
  `CrossDexOpportunity`. Resolve `PoolRef` pelo label (cheapPool=compra, expensivePool=venda),
  extrai router/fee/dexType/extraData. Reusa os tipos do strategy.
- **A2 — Re-cotação no dispatch (freshness).** O scan é a cada ~12s; preço move. Antes de construir,
  `quoteFanout` no bloco atual nas 2 pernas (o detector já faz isso por bloco). Sem isso, dispara num
  spread que já fechou.
- **A3 — Build + simulate + dispatch.** `buildFlashloanCalldata` (com flash selector) →
  `simulateArbitrage` → **mis-dispatcher** espelhando `dispatchBackrun` (modos dryrun/testnet/mainnet,
  wallet, gasOracle, dedup, relay opcional).
- **A4 — Config de execução.** Estender `apps/mis-scanner/src/config.ts` (zod): `EXECUTOR_PRIVATE_KEY`
  (chave EXCLUSIVA — regra inviolável), `ARB_EXECUTOR_ADDRESS`, modo, e circuit breakers
  (`MAX_TRADE_ETH`, `minProfitWei`, kill switch).
- **A5 — EV gate + filtro.** `filterOpportunity` + `scoreOpportunity` → `arbEdgeGate` (mín. EV USD),
  pra não disparar em spread que não cobre gás + slippage + flashloan fee.

### PARTE B — Espelhar a inteligência no Motor 2 (a parte que você cobrou)

> Tudo já existe; é instanciar no boot do MIS no mesmo padrão do Motor 1/3.

- **B1 — EventBus + EventIngester.** Tira o MIS do isolamento write-only; liga ao loop de eventos +
  sinks (Discord/webhook) + ledger automático.
- **B2 — Competidores.** `SenderRegistry` + `BlockHistoryScanner` + `CooccurrenceAnalyzer` +
  `BuilderAttributionTracker` + `marketBribeStats`. **Arb é competitivo — o motor tem que ver o
  adversário** (exatamente o que você apontou).
- **B3 — PnL/calibração/falhas.** `PnlReconciler` (+ `onReconcile` → `PnlAggregator` +
  `CalibrationDriftTracker`) + `FailureCollector`. Reconcilia esperado vs real, alarme de drift.
- **B4 — Post-mortem.** `CompetitorResolver` + `BlockPositionTracker` — quem nos ganhou o arb e onde
  caímos no bloco (perdemos corrida? sandwich?).
- **B5 — Auto-calibração.** Loop `computeAdaptiveThresholds` (600s) ajustando o EV gate do A5 a partir
  do histórico — o motor se calibra sozinho.
- **B6 — Bribe no arb.** `marketBribeStats` → `BribeConfig` no arb (inclusão privada/competitiva),
  reusando o que já fizemos.

### PARTE C — Visão TRIANGULAR (N-leg) — onde mora a oportunidade na profundidade

- **C1 — Grafo de tokens.** A partir do universo de pools que o MIS **já lê** (nó = token, aresta =
  pool com taxa + liquidez). Zero RPC novo — reusa o pool state reader.
- **C2 — Busca de ciclos.** Ciclos lucrativos A→B→C→A (Bellman-Ford no espaço −log(taxa) p/ detectar
  ciclo negativo, ou DFS limitado a 3 hops). Produto das taxas > 1 + custo.
- **C3 — Builder N-leg.** Generalizar `buildSwapSteps` de 2 → N (o contrato já aceita N). 3 steps =
  triangular.
- **C4 — Cotação + sizing do ciclo.** Multicall do quoter nas 3 pernas (cotação exata, não spot) +
  otimização de tamanho (reusa `optimizeFlashLoan`). Gate de profundidade ainda mais crítico (3 swaps
  = mais slippage acumulado).
- **C5 — Segurança de path.** `tokenSafety` multi-hop (**já existe**) + persistência por ciclo.
- **C6 — Unificação.** Observações triangulares no MESMO ledger/scoring/intelligence do cross-DEX
  (categoria nova `arb_triangular_observed`). Tudo cai no loop de auto-calibração.

### PARTE D — Fechar as 2 pontas soltas do Motor 3 (espelhar o que fizemos no Motor 1)

- **D1 — PnlAggregator + CalibrationDriftTracker** no backrun (reusa o `onReconcile`).
- **D2 — CompetitorResolver + BlockPositionTracker** no post-mortem do backrun (quem ganhou a corrida).

---

## 4. Considerações de "competir de fato" (autonomia + latência)

- **Re-cotação obrigatória no dispatch** (A2/C4): sem isso, latência transforma lucro em revert.
- **Auto-calibração liga os gates ao histórico** (B5): o bot aperta/afrouxa sozinho conforme o mercado.
- **Competidor-aware** (B2/B4): dimensiona bribe e decide brigar ou pular vendo a intensidade real.
- **Tudo numa TX atômica** (flashloan): triangular falho = só gás, nunca capital — por isso vale o risco.
- **Triangular é mais caro e mais disputado** (3 swaps): o gate de profundidade/persistência separa
  o edge real do ruído. É leverage de planejamento: menos improviso na hora.

---

## 5. Veredito final

Removendo infra/MAIN/gás/mempool da equação, a nível de **software**:
- **Motor 1:** nada falta.
- **Motor 3:** faltam D1+D2 (2 peças pequenas, reuso).
- **Motor 2:** falta Parte A (execução), Parte B (inteligência espelhada) e Parte C (triangular).

Depois disso, os **3 motores ficam no mesmo nível**: inteligentes, competidor-aware, auto-calibráveis,
sem pontas soltas — só esperando a infra de cada um para ligar.
