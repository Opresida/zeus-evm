# Viabilidade Técnica — Pre-Liquidations do Morpho no Motor 1 (ZEUS)

> **Decisão (Humberto, jun/2026):** vale mexer em código **antes** do DRY_RUN. Se Morpho é o único
> edge, entramos no mercado cobrindo **clássico + pre-liquidation** — senão queimamos 14 dias
> endereçando só ~70% do fluxo (os ~30% opt-in vão pra outros). Esta nota mapeia o **tamanho honesto
> da empreitada**: o que reusamos, o que é novo, o risco de EIP-170, e a economia real.
> **Companion:** `docs/COMPETITIVE_ANALYSIS_2026-06.md` §1.2.

---

## 0. TL;DR

- **Viável e bem alinhado** com o que já temos. Reusamos ~80% da tubulação (swap multi-DEX, gates,
  simulador, dispatcher, discovery de mercado/posição).
- **A execução é mais simples que a liquidação clássica** num ponto: pre-liquidation usa **callback
  `onPreLiquidate` → não precisa do nosso flashloan** (o contrato te dá o colateral antes de cobrar a
  dívida). Mas é uma **forma de controle DIFERENTE** da atual (hoje a liquidação Morpho roda *dentro*
  do nosso flashloan, com `data=""` e sem callback).
- **EIP-170:** o `ZeusLiquidator` está apertado (21.889 B / folga 2.687 B). Recomendação:
  **contrato satélite `ZeusMorphoPreLiquidator`** (padrão que já usamos no `ZeusMoonwellLiquidator`)
  — zero risco de estourar o limite + isolamento limpo. Inline só se a medição provar folga.
- **O verdadeiro trabalho novo é a DESCOBERTA off-chain** (achar quem optou + está na faixa
  pré-liquidável), não a execução.
- **Caveat econômico honesto:** bônus menor (`preLIF`) + fechamento parcial (`preLCF` ~10% no início)
  → só compensa em **posições grandes** ou perto do LLTV. Em posições pequenas o gas come tudo.

---

## 1. A mecânica — o delta vs. a liquidação clássica

### 1.1 Como fazemos a liquidação Morpho HOJE (clássica)
Tudo roda **dentro do nosso flashloan** (`_initiateFlash` → `onMorphoFlashLoan` → `_morphoCore`):
1. Flashloan do `loanToken` (Morpho/Balancer/Aave, seletor 0%).
2. `IMorpho.liquidate(marketParams, borrower, seized, repaid, "")` — **`data=""` → SEM callback**;
   o colateral volta direto pro `ZeusLiquidator`.
3. `_executeSwaps(swapSteps)` — colateral → loanToken (já multi-DEX UniV3/Aero; Slipstream no contrato).
4. Repaga o flashloan; valida `minProfitWei`; manda lucro.

`ZeusLiquidator.sol:527–598` (`_morphoCore`), `:625–645` (`_executeSwaps`).

### 1.2 Como é a PRE-liquidation (do contrato oficial `morpho-org/pre-liquidation`)
Chamamos um **contrato PreLiquidation por-mercado** (não o Morpho direto), que usa **callback**:

```solidity
// no contrato PreLiquidation do mercado:
function preLiquidate(address borrower, uint256 seizedAssets, uint256 repaidShares, bytes calldata data)
    external returns (uint256, uint256);

// o NOSSO contrato (satélite) implementa:
function onPreLiquidate(uint256 repaidAssets, bytes calldata data) external;
```

Fluxo (o contrato orquestra um `Morpho.repay` com callback; o `onPreLiquidate` cai *dentro* do
`onMorphoRepay`, **após** o colateral nos ser entregue e **antes** de o loanToken ser cobrado):
1. Chamamos `preLiquidate(borrower, seizedAssets, 0, data)` (ou `(borrower, 0, repaidShares, data)`).
2. O contrato saca o colateral e **entrega pra nós**.
3. Chama o nosso **`onPreLiquidate(repaidAssets, data)`**.
4. No callback: `_executeSwaps(swapSteps)` (colateral → loanToken) — **mesmo guts de hoje** — pra
   termos `>= repaidAssets` do loanToken; aprovamos pro pull do repay.
5. O contrato cobra o `repaidAssets`; sobra = lucro.

**Parâmetros do contrato PreLiquidation (immutables, lemos por view):**
`PRE_LLTV, PRE_LCF_1, PRE_LCF_2, PRE_LIF_1, PRE_LIF_2, PRE_LIQUIDATION_ORACLE` +
market params (`LOAN_TOKEN, COLLATERAL_TOKEN, ORACLE, IRM, LLTV`).
- **`preLIF`** (incentivo) interpola linear: `PRE_LIF_1` no `preLltv` → `PRE_LIF_2` no `LLTV`.
- **`preLCF`** (close factor) idem: limita quanto da dívida dá pra fechar (parcial/gradual).

### 1.3 O ponto-chave
**O callback `onPreLiquidate` é gêmeo do callback de flashloan/liquidação que já tratamos.** O miolo
(swap colateral→dívida via `_executeSwaps`) é **idêntico**. Muda: (a) o entry point, (b) a interface
do callback, (c) **não precisa do nosso flashloan** no caminho feliz.

---

## 2. On-chain — plano + EIP-170

### 2.1 Recomendação: contrato satélite `ZeusMorphoPreLiquidator`
Motivos:
- **EIP-170:** `ZeusLiquidator` = 21.889 B, folga **2.687 B**. Um novo entry + callback + struct decode
  (+ a variante `WithBribe`, que dobra) pode facilmente comer 1–2 KB → **risco real de estourar**.
- **Padrão que já temos:** `ZeusMoonwellLiquidator` e `BribeManager` já são satélites. Encaixa na
  arquitetura v8 (split por EIP-170). Atende ao seu pedido: *"se for o caso, faça um contrato novo e
  que se comuniquem, cheque se não vai estourar o limite."*
- **Isolamento:** pre-liquidation é uma superfície de ataque nova (callback de terceiro) — melhor
  isolada num contrato dedicado com seu próprio `nonReentrant` + whitelist de PreLiquidation contracts.

**O satélite implementa:**
- `executePreMorphoLiquidation(PreMorphoLiquidationParams)` — `onlyOperator whenAlive nonReentrant`.
- `executePreMorphoLiquidationWithBribe(...)` — variante (opt-in, igual hoje).
- `IPreLiquidationCallback.onPreLiquidate(uint256 repaidAssets, bytes data)` — decodifica `swapSteps`,
  roda swap, aprova o repay. **Guard:** `msg.sender` ∈ whitelist de PreLiquidation contracts conhecidos
  (default-deny, igual `approvedRouter`).
- Reusa as libs de swap **inline** (UniswapV3Lib + AerodromeLib + SlipstreamLib) — copiar o
  `_executeSwaps` (≈mesmo código) + `approvedRouter`.
- Bribe (opt-in) delega pro `BribeManager` já existente (mesmo `_callBribeManager`).

**Struct nova** `PreMorphoLiquidationParams`: `preLiquidation` (addr do contrato), `loanToken`,
`collateralToken`, `borrower`, `seizedAssets`, `repaidShares`, `swapSteps[]`, `minProfitWei`,
`profitReceiver`. **Sem `flashSource`** (não há flashloan no caminho feliz).

### 2.2 Medição obrigatória (antes de fechar o design)
- `forge build --sizes` no satélite (esperado bem abaixo de 24.576 B — é um contrato pequeno).
- Confirmar que **NÃO tocamos** no `ZeusLiquidator` (satélite = zero risco pro contrato apertado).
- Se um dia quisermos inline no `ZeusLiquidator`: medir +entry +callback; só se folga > ~1,5 KB.

### 2.3 Reuso vs. novo (on-chain)
| Componente | Status |
|---|---|
| `_executeSwaps` + libs (UniV3/Aero/Slipstream) + `approvedRouter` | ♻️ **reuso** (copiar pro satélite) |
| `BribeManager` + `_callBribeManager` | ♻️ reuso |
| Padrão `onlyOperator/whenAlive/nonReentrant/minProfitWei/profitReceiver` | ♻️ reuso |
| Entry `executePreMorphoLiquidation[WithBribe]` | 🆕 novo |
| Callback `onPreLiquidate` + whitelist de PreLiquidation contracts | 🆕 novo |
| Struct `PreMorphoLiquidationParams` | 🆕 novo |
| Flashloan plumbing (`_initiateFlash`/`onMorphoFlashLoan`) | ⛔ **não usado** no caminho feliz |

---

## 3. Off-chain — onde mora o trabalho novo de verdade

### 3.1 Descoberta (🆕 o maior pedaço novo)
Hoje a discovery clássica acha `HF < 1` no Morpho (`discovery.ts:178–210`). Pre-liquidation precisa de
uma **discovery paralela**:
1. **Achar os contratos PreLiquidation** que existem na Base → scan de eventos da
   **`PreLiquidationFactory`** (CREATE2; eventos de criação). Cachear addr → market params + config.
2. **Achar quem autorizou** cada PreLiquidation contract → `Morpho.isAuthorized(borrower, preLiq)` (a
   pre-liquidation exige autorização na Morpho). Cruzar com os borrowers já conhecidos do market cache.
3. **Filtrar a faixa pré-liquidável:** posições com `preLltv < LTV (< LLTV)` — usa o oracle do
   PreLiquidation contract (`PRE_LIQUIDATION_ORACLE`, pode diferir do market oracle).
- **♻️ Reuso:** market cache (`markets.ts`), leitura de oracle/posição (multicall), math de LTV/HF
  (`math.ts`), `BorrowerCache`.
- **🆕 Novo:** scan da factory, `isAuthorized`, leitura da config do PreLiquidation (views), math de
  `preLIF`/`preLCF`.

### 3.2 Calculator (🆕 math nova, ♻️ quote reusado)
- **♻️ Reuso:** `bestCollateralToLoanQuote` (o multi-DEX single-hop que acabamos de fazer) pro swap.
- **🆕 Novo:** profit com `preLIF` (bônus menor, interpolado) + quanto dá pra fechar com `preLCF` no
  LTV atual. Profit = `swapOutput(seizedCollateral) − repaidAssets` (sem fee de flashloan). Gate de
  USD/slippage igual ao clássico (`MIN_LIQUIDATION_PROFIT_USD`).

### 3.3 Builder + Pipeline + Config (♻️ template do clássico)
- **Builder:** `buildPreMorphoLiquidationTx` — espelha `builder.ts:49–117`, encoda
  `executePreMorphoLiquidation[WithBribe]`, reusa o `swapPlan`/SwapStep multi-DEX.
- **Pipeline:** `runPreMorphoPipeline` — espelha `runMorphoPipeline` (`pipeline.ts:867–1072`): **reusa
  todos os gates** (kill switch, cooldown, gas, dedup, auto-pause), o **simulador eth_call**, o
  **stale-check** e o **dispatcher**. Só troca calculator/builder.
- **Config:** add `morpho.preLiquidationFactory` (Base) em `chain-config/src/base.ts` + types.
- **Eventos/painel:** reusa `tx.confirmed` (protocol `morpho-blue`, ou um tag `morpho-preliq` pra
  separar no painel). `swapVenue` já viaja (multi-DEX). Zero migração de schema.

### 3.4 Reuso vs. novo (off-chain) — resumo
| Camada | ♻️ Reuso | 🆕 Novo |
|---|---|---|
| Discovery | market cache, oracle/posição, LTV math | factory scan, `isAuthorized`, config PreLiq, `preLIF/preLCF` |
| Calculator | `bestCollateralToLoanQuote`, gates USD | math de preLIF/preLCF, sem fee flashloan |
| Builder | SwapStep/swapPlan multi-DEX | encode do novo entry |
| Pipeline | gates, simulador, stale-check, dispatcher | runner novo (cópia magra) |
| Config/eventos | schema, webhook, painel | endereço da factory |

---

## 4. Economia real — o caveat honesto

- **Bônus menor (`preLIF`)** + **fechamento parcial (`preLCF` ~10% no início)** → o lucro absoluto por
  pre-liquidação **começa pequeno** e cresce conforme a posição se aproxima do LLTV.
- **Implicação:** pre-liquidation compensa em **posições grandes** (LSD/stable de tamanho real) ou
  **perto do LLTV** (close factor maior). Em posições pequenas, o gas come o bônus reduzido → o nosso
  gate `MIN_LIQUIDATION_PROFIT_USD` já filtra isso, mas é bom saber que o canal é **seletivo**.
- **Lado bom competitivo:** por ser **gradual**, não é "tudo num bloco só" — múltiplos liquidadores
  pegam fatias ao longo de blocos. Isso **alivia a corrida de latência** (menos winner-take-all) →
  terreno *mais* favorável ao nosso stack TS do que a liquidação clássica grande.
- **O número que falta:** PnL líquido real de uma pre-liquidação típica na Base. **Só o DRY_RUN
  responde** — mesmo teste de existência do edge clássico.

---

## 5. Fases sugeridas (sem pressa, testando a cada passo — padrão Humberto)

> Cada fase: `pnpm typecheck` + teste + commit isolado. Contrato: `forge build --sizes` + fork test.

1. **Fase 0 — Confirmar fatos on-chain** (Antigravity, via RPC): endereço da `PreLiquidationFactory`
   na Base; assinatura/ABI exata do `PreLiquidation` (views de config + `preLiquidate`); alvo do
   approve no repay (Morpho singleton vs. PreLiquidation). **Bloqueia o resto.**
2. **Fase 1 — Contrato satélite** `ZeusMorphoPreLiquidator` + interface `IPreLiquidationCallback` +
   struct. `forge build --sizes` (confirmar « 24.576 B). Unit tests.
3. **Fase 2 — Fork test** (Base): `preLiquidate` num PreLiquidation real → callback → swap → repay.
   Prova ABI/wiring/whitelist (igual aos forks que já temos). Skip sem `BASE_RPC_ARCHIVE`.
4. **Fase 3 — Off-chain discovery** (factory scan + `isAuthorized` + faixa pré-liquidável). Testes.
5. **Fase 4 — Calculator + builder + pipeline runner** (espelha o Morpho clássico). Testes.
6. **Fase 5 — Redeploy testnet** (Base Sepolia, regra de sempre: testnet primeiro) + ligar no DRY_RUN.
7. **Fase 6 — Observar no DRY_RUN:** o painel mostra pre-liquidações lado a lado das clássicas;
   medir PnL/won-lost real (responde o caveat da §4).

**Branch sugerida:** nova, `claude/motor1-morpho-preliquidation` (a partir da `main` atual).

---

## 6. Riscos / pontos a confirmar

### 6.1 ✅ FASE 0 CONFIRMADA on-chain (Antigravity via RPC Alchemy + cast + Dune · 2026-06-26)

> Fonte de endereço: `morpho-org/sdks` (`packages/morpho-ts/src/addresses.ts`, bloco `BaseMainnet`).
> Verificação: `cast` contra Base mainnet (Alchemy) + contagem de eventos via **Dune API** (`base.logs`).
> Código do contrato: `morpho-org/pre-liquidation@main` (`PreLiquidation.sol`, interfaces, `EventsLib`).

**1. Endereço da `PreLiquidationFactory` na Base (8453):**
`0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef` — **verificado on-chain** (bytecode 8,4 KB presente;
`isPreLiquidation(address)` responde `false` p/ addr aleatório = é a factory real). _(Ethereum mainnet é
`0x6FF33615e792E35ed1026ea7cACCf42D9BF83476` — diferente; não confundir.)_

**2. ABI exata (difere do que a nota assumia — a config vem AGRUPADA, não em views individuais):**
- Entry: `preLiquidate(address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) → (uint256,uint256)`.
- Config (1 view, struct): `preLiquidationParams() → (uint256 preLltv, uint256 preLCF1, uint256 preLCF2,
  uint256 preLIF1, uint256 preLIF2, address preLiquidationOracle)`. **Não há** getters `PRE_LLTV()`/`PRE_LIF_1()`
  individuais públicos — ler o struct.
- Market: `marketParams() → (loanToken, collateralToken, oracle, irm, lltv)` + `MORPHO()` + `ID()` (públicos).
- Callback (o que o NOSSO satélite implementa): `IPreLiquidationCallback.onPreLiquidate(uint256 repaidAssets, bytes data)`.

**3. Alvo do approve no repay — CORREÇÃO: é o contrato `PreLiquidation`, NÃO o Morpho singleton.**
Lendo `PreLiquidation.onMorphoRepay` (linha 181-192): (a) `MORPHO.withdrawCollateral(..., liquidator)` entrega
o colateral **direto pra nós**; (b) chama `onPreLiquidate(repaidAssets, data)` (fazemos o swap); (c)
`ERC20(LOAN_TOKEN).safeTransferFrom(liquidator, address(this), repaidAssets)` — quem faz o `transferFrom`
é o **próprio contrato PreLiquidation** (`address(this)`). Logo **aprovamos o loanToken pro contrato
PreLiquidation** (o spender), não pro Morpho. _(O PreLiquidation já aprova o Morpho no constructor — não é
problema nosso.)_

**4. Adoção real na Base (via Dune `base.logs`, eventos da Factory + `PreLiquidate`):**
- **110 contratos `PreLiquidation` criados** (evento `CreatePreLiquidation`), cobrindo **107 markets distintos**
  (1º: 2025-04-02 · último criado: 2026-02-17).
- **USO REAL (decisivo): 3.342 pré-liquidações executadas** (evento `PreLiquidate`) — **966 nos últimos 90 dias**
  (~**11/dia**), **última hoje (2026-06-26)**. **42 liquidadores distintos** competindo, em **22 markets ativos**
  (de 107) via **23 contratos** (de 110). **NÃO é ~0 — é um mercado vivo, diário e competido.**
- TVL coberto por market = medição mais profunda (somar posições dos borrowers autorizados por contrato);
  pendente, mas o **volume de execução** (3.342 / ~11/dia) já responde a pergunta de adoção.

**Veredito Fase 0 → GO.** Factory existe + verificada; ABI/fluxo confirmados; adoção viva (~11 pré-liq/dia,
edge Morpho 0% recapture segue aberto). Ressalva honesta: **42 liquidadores = há competição** — mas a
pré-liquidação é gradual/parcial (§4), menos winner-take-all, terreno OK pro nosso stack. **Próximo passo
(ao dar GO): add `morpho.preLiquidationFactory: '0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef'` em
`chain-config/src/base.ts` + Fase 1 (satélite `ZeusMorphoPreLiquidator`).**

### 6.2 Itens originais (status pós-Fase 0)
- ✅ ~~Endereço da PreLiquidationFactory na Base~~ — **confirmado** (§6.1).
- ✅ ~~Alvo do approve no callback~~ — **confirmado: contrato PreLiquidation** (§6.1, corrige "provável Morpho singleton").
- ⚠️ **`seizedAssets` vs `repaidShares`** — confirmado que `preLiquidate` aceita os DOIS modos (passar um, deixar
  o outro 0). O contrato chama `MORPHO.repay(..., 0, repaidShares, ...)` internamente (modo por shares). Escolher
  `repaidShares` limitado por `preLCF` (espelha o clássico). Math fina: Fase 4.
- ✅ **Oracle do PreLiquidation** pode diferir do market oracle → confirmado: `preLiquidationParams().preLiquidationOracle`
  é campo próprio. Discovery DEVE ler esse, não o do market.
- ✅ ~~Adoção ~30%~~ — **medido na Base** (§6.1): 110 contratos / 3.342 execuções / ~11/dia. Real.

---

## 7. Veredito

**Faz sentido construir antes do DRY_RUN** (alinhado com a decisão do Humberto): o custo é moderado
(~80% reuso, satélite limpo sem risco de EIP-170), e sem isso entramos no mercado endereçando só parte
do fluxo do nosso único edge. **Porém**, a **Fase 0** (confirmar factory + ABI + adoção real na Base)
deve vir **primeiro** — se a adoção de pre-liquidation na Base for muito menor que os ~30% globais, o
ROI das 6 fases cai e a gente repriioriza. Barato confirmar, caro construir no escuro.

---

## Fontes
- [morpho-org/pre-liquidation (contrato oficial)](https://github.com/morpho-org/pre-liquidation) ·
  [Morpho Docs — Liquidation](https://docs.morpho.org/learn/concepts/liquidation/) ·
  [Introducing Pre-Liquidations](https://paragraph.com/@morpho/introducing-pre-liquidations-enhanced-loan-management-on-morpho)
- Mapa do código interno: `ZeusLiquidator.sol` (`_morphoCore` :527–598, `_executeSwaps` :625–645),
  `apps/liquidator/src/protocols/morpho/*`, `pipeline.ts:867–1072`, `chain-config/src/base.ts`.
