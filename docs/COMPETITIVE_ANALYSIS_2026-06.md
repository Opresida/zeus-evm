# Análise Competitiva — ZEUS EVM vs. mercado MEV/flashloans (junho 2026)

> **Atualização** da `docs/refs/competitive-landscape.md` (de 15/06/2026). Cruza a análise original
> com dados frescos de jun/2026 (web search multi-fonte). **Propósito:** retrato honesto de onde o
> ZEUS está frente à concorrência, pra embasar a decisão antes do DRY_RUN com capital real.
> **Honestidade > otimismo cego.** Documento de discussão — não é commit de código.

---

## TL;DR — a nota não melhorou, e o motivo é incômodo

| Lente | 15/06 | Agora (jun/2026) | Movimento |
|---|---|---|---|
| **Como software / engenharia** | 7,5 | **~8,0** | ↑ (multi-DEX no Motor 1, toggle remoto, OIE, 150 testes) |
| **Como competidor que ganha $ HOJE** | 4,5 | **~4,0** | ↓ **o mercado fechou portas mais rápido do que evoluímos** |

A verdade dura: **melhoramos o produto, mas o nosso principal edge (liquidação) encolheu no mesmo
período.** Não é falha de engenharia — é o mercado se profissionalizando contra o liquidador externo.
O recuo de meio ponto na nota de "competidor" reflete três portas que se fecharam (abaixo).

---

## 1. O que mudou desde 15/06 — os 4 fatos novos que importam

### 1.1 ⚠️ A captura de OEV na Aave agora está LIVE na Base — confirmado e em escala
No doc interno de 15/06 isso era "se espalhando". Agora é fato consumado:
- A Aave aprovou (votação quase unânime, **Q1/2026**) o **Chainlink SVR na Base e Arbitrum**.
- Números frescos: **US$ 18,3M recapturados no total · US$ 8,3M só no Q1/2026 · 99% de market share ·
  recaptura média >80% (picos >90%)**.
- Pior pro nosso lado: **a Compound também integrou SVR** (junto de Vyro e Steakhouse Finance).
- **Implicação:** Aave e Compound III na Base viraram **terra arrasada** pro liquidador externo.
  Nosso pipeline cobre os dois, mas o edge lá hoje ≈ **zero**.

### 1.2 🟡 O Morpho — nosso "único edge real" — mudou de forma (ameaça OU oportunidade)
- O Morpho **abriu o código do liquidation bot oficial** (`morpho-blue-liquidation-bot`): multi-chain,
  modular, com "pluggable data providers, liquidity venues e pricers". Roda em qualquer EVM onde o
  Morpho existe — inclui a Base. Existem bots community maduros (`crisog/morpho-liquidator`, etc.).
- **Pre-Liquidations (a novidade que mais importa):** o tomador *opta* por um contrato que permite
  liquidá-lo **mais cedo** (num limite apertado `preLltv`, *antes* de furar o LLTV), **aos poucos**
  (parcial/gradual: ~10% no começo, subindo a 100% perto do LLTV) e com **bônus menor** (`preLIF` <
  bônus normal). **~30% dos borrows do Morpho já optaram** (abril/2026) → um terço do fluxo de
  liquidação agora passa por esse canal, que o nosso bot clássico **não toca**.

**Achado decisivo (do contrato oficial `morpho-org/pre-liquidation`):**
1. **`preLiquidate` é PERMISSIONLESS** — qualquer searcher pode chamar. **Nós inclusive.** Não é
   reservado a um liquidador autorizado.
2. **Tem callback `onPreLiquidate`** — o contrato entrega o colateral *antes* de cobrar a dívida; você
   troca colateral→dívida no meio (atômico). O Morpho diz: *"elimina a necessidade de flashloan."*

**Implicação corrigida** (a versão anterior deste doc tratava como pura ameaça — estava impreciso):

| Cenário | Consequência |
|---|---|
| **Se ignorarmos** (só `liquidate` clássico) | 🔴 **Ameaça.** Os ~30% opt-in são pré-liquidados por outros (incl. o bot oficial) **antes** de virarem nosso alvo, e chegam já raspados. Mercado endereçável encolhe ~30%. |
| **Se construirmos o caminho** | 🟢 **Oportunidade.** Permissionless + callback (até *mais simples* que a liquidação normal — sem flashloan). Reusa a skill que já temos (detectar + swap colateral→dívida com nosso multi-DEX). Bônus menor = **menos elite competindo** = terreno *menos* latency-sensitive → **mais favorável ao nosso stack TS** que a corrida clássica grande. |

> **Decisão estratégica (Humberto, jun/2026):** vale mexer em código **antes** do DRY_RUN, não depois.
> Se Morpho é o único edge, entramos no mercado cobrindo clássico **+** pre-liquidation — senão a gente
> queima 14 dias sabendo que está endereçando só parte do fluxo. Viabilidade técnica em
> `docs/PRE_LIQUIDATION_FEASIBILITY.md`.

### 1.3 Apareceu feed premium de Flashblocks na Base (que não temos)
- A **bloXroute agora streama os Flashblocks via WebSocket/gRPC** (~200ms): "act earlier on MEV, arbs,
  liquidations". Confirmações Flashblocks-enabled ficam em ~300–500ms.
- Isso é exatamente o "mempool premium" do tier acima de nós — e na Base virou realidade comprável.
- **Implicação:** quem paga, vê o bloco/estado antes. Nós lemos via RPC Alchemy. Desvantagem de
  latência na detecção, justo no momento (HF < 1) em que ser o primeiro decide a liquidação.

### 1.4 O recado direto sobre solo devs (de uma das fontes)
> *"O desenvolvedor solo está sendo espremido por firmas capitalizadas que pagam nodes RPC de
> US$ 3.000/mês, taxas de co-location e engenharia especializada."*

É o nosso perfil, dito com todas as letras. Não muda a estratégia, mas calibra a expectativa.

---

## 2. Quem são os concorrentes (por tier, com nomes)

| Tier | Quem | Distância do ZEUS |
|---|---|---|
| **Elite verticalizada** | Wintermute, SCP (builder próprio + orderflow exclusivo) | ❌ Outro planeta |
| **Searcher solo de elite** | jaredfromsubway.eth (Rust, infra privada) | ❌ Longe |
| **Multi-chain comercial** | **MevX** (Eth/Solana/BNB/Tron/**Base**), bots Telegram | 🟡 Mais distribuídos, menos especializados em liquidação |
| **Bot oficial de protocolo** | **morpho-blue-liquidation-bot** (open-source, modular) | 🟡 **Compete direto no nosso edge** — mantido por quem fez o protocolo |
| **Bem-construído, não-comprovado** | **← ZEUS** | ✅ aqui |
| **Hobby / retail** | `simple-arbitrage`, `mev-templates`, repos de tutorial | ⬆️ Estamos acima |

**Onde o ZEUS genuinamente se destaca** vs. a maioria desses: **3 motores descorrelacionados** +
camada de inteligência (DuckDB/OIE, reconciliação de PnL, EV gate competitor-aware, scoring de
persistência) + **multi-DEX no swap de liquidação** (recém-mergeado). A esmagadora maioria dos bots
open-source é mono-estratégia e sem instrumentação. **Isso é real e é nosso.**

---

## 3. Head-to-head nos eixos que decidem dinheiro

| Eixo | ZEUS | Concorrente que ganha | Veredito |
|---|---|---|---|
| **Capital** | flashloan 0% (Morpho/Balancer) | igual | 🟰 empate — não é diferencial |
| **Cobertura de estratégia** | 3 motores + multi-DEX + triangular | mono-estratégia | 🟢 **vantagem nossa** |
| **Inteligência / calibração** | OIE, scoring, EV gate, PnL reconciliation | quase ninguém tem | 🟢 **vantagem nossa** |
| **Latência (o fio)** | TS+viem, RPC Alchemy | Rust + co-location + feed premium | 🔴 **desvantagem estrutural** |
| **Orderflow privado** | nenhum | builder integration / MEV-Share | 🔴 não temos |
| **Edge de liquidação** | Morpho (resto fechado por SVR) | mesmo alvo + bot oficial + pre-liq | 🟡 **edge estreito e disputado** |
| **Maturidade operacional** | US$ 0 real, nunca rodou com capital | milhares de liquidações landed | 🔴 não comprovado |

---

## 4. Veredito honesto

**Como engenharia, estamos no topo do que um time solo bem-feito produz** — provavelmente acima de
90% dos bots open-source existentes. Multi-DEX, toggle armado-mas-travado, camada OIE, 150 testes
Foundry: trabalho de gente séria.

**Como máquina de ganhar dinheiro hoje, continuamos no mesmo lugar (talvez meio ponto abaixo)**,
porque os dois fossos que nunca tivemos — **latência e orderflow** — ficaram *mais* decisivos na Base
(Flashblocks + feed premium da bloXroute), e o nosso melhor alvo de liquidação (Aave/Compound)
**fechou de vez por OEV capture**. Sobrou o Morpho, que é real mas **estreito e cada vez mais
disputado**.

Isso **não invalida o projeto** — valida a estratégia que já está no plano: o lucro só se prova no
**DRY_RUN com dado real**, não no código. A pergunta que o DRY_RUN tem que responder é brutal e
específica:

> **"No Morpho da Base, com TS+viem e RPC Alchemy, quantas corridas de liquidação a gente ganha
> contra o bot oficial do Morpho e os outros searchers — e a que custo de gas em reverts?"**

Se a resposta for "ganhamos uma fração decente", temos negócio. Se for "perdemos quase todas no fio",
a conversa vira **Rust no hot-path** ou **um nicho onde latência não decide** (long-tail / markets
exóticos que os bots grandes ignoram).

---

## 5. O que moveria nossa agulha competitiva (em ordem de impacto)

1. **Provar o edge no Morpho no DRY_RUN** — métrica concreta de won/lost vs. gas queimado. É o
   próximo passo que já está no plano; **tudo depende disso.**
2. **Feed de Flashblocks** (bloXroute WS/gRPC) — o caminho mais barato pra reduzir a desvantagem de
   latência sem reescrever em Rust. Vale cotar o custo/integração.
3. **Caçar long-tail / markets novos do Morpho** onde os bots grandes ainda não chegaram — nosso
   scoring de persistência (OIE) é justamente a ferramenta pra achar esses nichos antes deles.
4. **Pivô do Motor 2 → filler UniswapX na Base** — em vez de brigar pelo spread cross-DEX (que os
   solvers internalizam), virar quem preenche as ordens. Permissionless, ~60-70% do código já serve,
   sem capital/KYC. Nicho real = long-tail. Viabilidade + economia em `docs/UNISWAPX_FILLER_FEASIBILITY.md`.
5. **Rust só no hot-path do backrun** — caro; só se o DRY_RUN mostrar que vale. E o Motor 3 ainda
   está bloqueado por falta de feed de mempool de qualquer jeito.

---

## 6. Pontos pra discutir (gancho pra conversa)

1. **Pre-Liquidations do Morpho** — ✅ **aprofundado (jun/2026).** É permissionless + callback (sem
   flashloan); ~30% opt-in. Decisão: virar **feature do Motor 1 antes do DRY_RUN** (cobrir clássico +
   pre-liq). Viabilidade técnica/EIP-170 em `docs/PRE_LIQUIDATION_FEASIBILITY.md`.
2. **Feed Flashblocks (bloXroute)** — vale o custo? Qual o ganho esperado de latência vs. preço
   mensal? (Definir se cotamos antes ou depois do DRY_RUN.)
3. **Foco do Motor 1** — dado que Aave/Compound fecharam por SVR, faz sentido manter os runners
   deles ligados (captura de sobras em ativos fora do SVR) ou concentrar 100% no Morpho?
4. **Estratégia de nicho** — apostar no long-tail do Morpho (onde latência pesa menos) é mais
   realista pro nosso stack TS do que brigar nos markets grandes? O OIE ajuda a achar esses?
5. **Critério de decisão pós-DRY_RUN** — que número de won-rate / PnL líquido justificaria capital
   real? E qual número nos diria "TS não aguenta, hora de Rust ou pivô"? Definir isso ANTES, pra não
   decidir no calor.
6. **Filler UniswapX (Motor 2)** — ✅ **aprofundado (jun/2026).** Barato de construir (~60-70% de reúso),
   mas margem fina (1-5 bps) e competição de MM com inventário → nicho = long-tail. Próximo passo é a
   **F0: medir os fills reais na Base on-chain ANTES de construir.** Detalhes em `docs/UNISWAPX_FILLER_FEASIBILITY.md`.

---

## Fontes (jun/2026)

- **OEV / SVR:** [Chainlink Q1 2026 Review (SVR Base/Arbitrum, US$ 8,3M no Q1)](https://chain.link/blog/quarterly-review-q1-2026) · [Aave integra SVR (PRNewswire)](https://www.prnewswire.com/news-releases/aave-integrates-chainlink-svr-on-ethereum-mainnet-to-recapture-liquidation-mev-and-increase-protocol-revenue-302414191.html) · [Chainlink SVR Feeds (docs)](https://docs.chain.link/data-feeds/svr-feeds)
- **Morpho:** [morpho-blue-liquidation-bot (oficial)](https://github.com/morpho-org/morpho-blue-liquidation-bot) · [Pre-Liquidations](https://morpho.org/blog/introducing-pre-liquidations-enhanced-loan-management-on-morpho/) · [crisog/morpho-liquidator](https://github.com/crisog/morpho-liquidator) · [Liquidation concepts (docs)](https://docs.morpho.org/learn/concepts/liquidation/)
- **Flashblocks / latência:** [Base — Flashblocks Deep Dive](https://blog.base.dev/flashblocks-deep-dive) · [bloXroute — Flashblocks Streams (WS/gRPC)](https://x.com/bloxroute/status/1960735843121029428) · [The Block — Base ativa Flashblocks](https://www.theblock.co/post/363109/coinbase-base-flashblocks)
- **Landscape:** [Gate Learn — L2 MEV (2 searchers >50% da Base)](https://www.gate.com/learn/articles/its-time-to-talk-about-l2-mev/3677) · [MEXC — Leading MEV Bots 2026 (MevX)](https://www.mexc.com/news/946666) · [dev.to — FlashArb em produção (28,5% reverts; gas em reverts)](https://dev.to/chronocoders/the-arbitrage-bot-arms-race-what-we-learned-running-flasharb-in-production-10ij)
- **Base (referência da análise original):** `docs/refs/competitive-landscape.md` (15/06/2026) — 15 fontes citadas lá.

> **Limites desta pesquisa:** números de latência (200–500ms) vêm de blogs de infra, não de papers —
> tratar como ordem de grandeza. Valores de recaptura SVR e de MEV são por período/janela, não
> lifetime. A ameaça real das Pre-Liquidations ao nosso fluxo ainda **não foi medida** — é hipótese
> a verificar (ponto 1 da seção de discussão).
