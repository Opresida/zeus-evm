# Cross-DEX & Triangular Arb — Raio-X de status (ZEUS motor #2)

> Estado atual da arbitragem cross-DEX/triangular: o que existe, o que falta, e como
> pares/pools são definidos. Levantado em 2026-06-15.
> Ver: [`engine-strategy.md`](./engine-strategy.md) · [`competitive-landscape.md`](./competitive-landscape.md).

---

## TL;DR

**A metade on-chain está pronta e forte. A metade off-chain para em "detectar + simular" —
falta o motor que aperta o gatilho (`apps/arb-engine`).** Resultado: hoje o arb **não fatura um
centavo** (é radar, não trader), mesmo achando oportunidade. Triangular é suportado pelo contrato
mas **não está ligado** off-chain.

---

## ✅ O que JÁ temos (e funciona)

### On-chain (contrato pronto, auditado, fork-tested)
`contracts/src/ZeusArbExecutor.sol` (v8):
- 3 funções: `executeArbitrage` (capital próprio), `executeFlashloanArbitrage` (3 fontes:
  Aave/Morpho/Balancer), `executeFlashloanBackrun` (com bribe).
- **Multi-hop ilimitado** (loop de N `SwapStep`) → **triangular É suportado on-chain** (2+ steps
  com tokens diferentes). Nunca testado, mas a estrutura existe.
- Circuit breakers (kill switch, maxTrade, minProfit) aplicam no arb.
- Adapters on-chain: **Uniswap V3 + Aerodrome**. Curve/Balancer são enum-stub (não implementados).

### Off-chain (detecção → simulação funciona)
- `packages/strategy/src/opportunities/crossDex.ts` — `findCrossDexArb` (A→B→A, fanout paralelo).
- `filters.ts` (profit/slippage/gas) · `executor/simulator.ts` (eth_call) · `executor/txBuilder.ts`
  (calldata) · `apps/backtest` (replay histórico).
- `apps/detector` roda em DRY_RUN: detecta + simula, **não dispara** (KILL_SWITCH=true).

---

## ❌ O que FALTA (priorizado)

| # | Gap | Impacto | Esforço |
|---|---|---|---|
| 🔴 **1** | **Não existe `apps/arb-engine` (sem dispatch).** Detector detecta+simula mas NUNCA envia tx | **Arb não fatura nada hoje** | ~2-3d (60% reusa liquidator) |
| 🔴 **2** | **Triangular não ligado off-chain.** Contrato suporta, mas `findCrossDexArb` é 2-leg e `txBuilder` é hardcoded em 2 steps | Sem rotas A→B→C→A na prática | ~1d (refactor txBuilder p/ N steps) |
| 🟡 **3** | **Só 2 DEXes** com quoter (Uni V3 + Aero). BaseSwap/Sushi/Pancake/Curve sem adapter | Perde arb nesses DEXes | ~1d por adapter |
| 🟡 **4** | **Só 3 pares fixos** monitorados (ver "varredura" abaixo) | Cobertura estreita | config |
| 🟡 **5** | Multi-hop quoter existe mas **não ligado** no fanout | Pares sem pool direto ficam de fora | ~1d |
| 🟡 **6** | Sem mempool (reativo pós-bloco); flashloan não-wired pro arb; gas hardcoded $0.5 | Margem/edge subótimos | médio |

**Blocker #1 é o que decide tudo:** liquidator e backrun têm pipeline de dispatch completo; o arb
não. Na estratégia "arb = baseline mensal", hoje esse baseline é **$0 garantido** — não por falta de
oportunidade, mas porque **nunca aperta o gatilho**.

**Edge estrutural esperando:** AERO/USDC tem ~**350x de desequilíbrio de liquidez** (Aerodrome $26M
vs Uni V3 $75k) — o tipo de fresta medium-cap que a pesquisa apontou como o único nicho viável.

---

## Como pares/pools são definidos — 3 camadas

### 1. Lista fixa curada
`packages/chain-config/src/target-pairs.ts` → `BASE_TARGET_PAIRS` (3 pares hardcoded).
Adicionar manualmente = novo objeto `TargetPair` (id, tokens, decimals, fee tiers, flags Aerodrome).

### 2. Varredura de mercado dinâmica — JÁ EXISTE ✅
`apps/discovery-scraper`: puxa top N pools do **GeckoTerminal** → agrupa por par → hard filters
(TVL, vol, idade, pool morto, wash, fragmentação) → **token safety** (GoPlus honeypot/tax/mintable)
→ scoring composto → escreve **`auto-targets/<chain>.json`**.

### 3. O merge
`getTargetPairsForChain(chainId)` junta **hardcoded + auto-targets.json** (curados têm prioridade;
varredura ADICIONA o novo). Dir configurável via env `AUTO_TARGETS_DIR`.

Ainda há o **`apps/mis-scanner`** ("Motor 2") — observação pura on-chain, ranqueia ineficiências por
**persistência**, persiste snapshot em disco.

### ⚠️ O CATCH crítico
**O `detector` (radar de arb) NÃO está ligado na varredura.** Ele importa `BASE_TARGET_PAIRS`
**direto** (`apps/detector/src/index.ts:131`), não usa `getTargetPairsForChain`. Quem usa a varredura
é só o **backrun-engine**.

→ Se a config de varredura for ajustada, ela alimenta o **backrun**, mas o **detector continua vendo
só os 3 pares fixos**. **Fix de ~1 linha:** trocar `BASE_TARGET_PAIRS` por `getTargetPairsForChain(8453)`
no detector. **Pendente — fazer pra o radar enxergar o mercado todo no DRY_RUN.**

---

## Escalar: DEX, pares, redes (confirmado)

- **Pares:** a varredura resolve (auto-discovery) — *se* o detector for ligado nela (catch acima).
- **DEXes:** a varredura *acha* pools, mas **cotar/executar** exige **adapter** — hoje só Uni V3 +
  Aerodrome (off-chain e on-chain). BaseSwap/Sushi/Pancake/Curve precisam de adapter (código).
- **Redes:** Base wired no detector; Optimism tem pares prontos; Arbitrum/Avalanche são stubs.
  Multi-chain no detector = mais código.

---

## Recomendação (ordem)

1. **Ligar o detector na varredura** (`getTargetPairsForChain`) — pequeno, alto valor pro DRY_RUN.
2. **Construir `apps/arb-engine`** — fecha o ciclo detecção→lucro (reusa dispatcher do liquidator +
   gates + EV gate da Etapa B). Sem ele o baseline de arb é zero.
3. **Refatorar `txBuilder` pra N steps** — destrava triangular + rotas complexas de uma vez.
4. **+DEXes (adapters) e +pares/redes** — amplia cobertura.
5. Triangular / multi-hop detection / mempool — depois, se o 2-leg provar edge.

---

## Resumo

Carro montado (contrato faz tudo, até triangular) + radar ligado (detecção+simulação), mas **falta o
motorista** (`arb-engine`) — e o detector está olhando por uma janela estreita (3 pares fixos) em vez
do mercado inteiro (varredura). Fechar esses dois é o que tira o motor #2 do papel.
