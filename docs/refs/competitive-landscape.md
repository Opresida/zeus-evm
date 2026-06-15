# Competitive Landscape — ZEUS EVM vs. o mercado de bots MEV/arbitragem

> **Pesquisa:** 2026-06-15 · multi-fonte (web search + fetch, 2024-2026) · fontes citadas no fim.
> **Propósito:** posicionar o ZEUS honestamente contra o estado da arte e informar a decisão
> do blocker #1 ("Estratégia com edge", Fase 4c). Honestidade > otimismo cego.

---

## TL;DR — a nota e os 2 achados que importam

**Nota do ZEUS vs. o mercado (composta):**

| Lente | Nota | Leitura |
|---|---|---|
| **Como software / engenharia** | **~7,5/10** | Topo do que um time solo bem-feito produz. |
| **Como competidor que ganha dinheiro HOJE** | **~4,5/10** | Falta fosso competitivo (orderflow/latência) + edge comprovado. |

A segunda é a resposta honesta. Ela é **mais baixa** de propósito: o MEV é um oligopólio onde
código bonito não vence sem orderflow privado, latência (Rust+co-location) ou edge comprovado — e
o ZEUS ainda não tem nenhum dos três, só a fundação pra construí-los.

**Os 2 achados acionáveis:**

1. ⚠️ **Liquidação na Base está se fechando por OEV capture.** Aave V3 já roda **Chainlink SVR**
   na Base (recaptura ~80-90% do valor da liquidação pro protocolo). Compound III idem. **Morpho
   Blue continua aberto** (bônus inteiro pro liquidador) → **é onde sobra edge real**. → Pivotar o
   foco do liquidator pra Morpho na Base; tratar Aave/Compound como "sobras" em ativos ainda não
   migrados.
2. **Na Base, o gargalo é LATÊNCIA, não capital.** Priority-ordering + sequencer central da
   Coinbase + Flashblocks (200ms) premiam co-location. Stack TS+viem do ZEUS é OK pra
   liquidação/arb atômica, mas **estruturalmente fraco em backrun** (short-tail, onde 50ms decidem).

---

## 1. A realidade crua do mercado MEV

O MEV em EVM é um **oligopólio extremo**, não um mercado aberto:

- **99,49% das wallets de bot perderam ou ficaram em ganho trivial**; só **0,51% lucraram
  >$1.000** (estudo com 95M txs, 2024-2025).¹ Proporção ~1 em 200.
- **Top 5 searchers capturam ~80% de todo o MEV**; em CEX-DEX arb, **3 searchers controlam
  73-90%** do volume.²,³
- **Na Base, ~2 entidades fazem 80%+ de toda a extração MEV** — o próprio relatório diz que
  *"as barreiras de entrada são significativas; o leilão atual não é realmente competitivo".*⁴
- **Block building:** top 10 builders constroem ~97,5% dos blocos (na L1).⁵
- **Economia da corrida:** numa oportunidade de $1.000, o vencedor gasta >$900 de gas (fica com
  ~$100) e **o segundo lugar PERDE >$50** de gas na tx que não landou.⁶ Perder custa dinheiro.
- **Custos escondidos reais:** um bot de arb em produção relatou 28,5% de txs revertidas e
  **$8.400 gastos em gas só nos reverts** em 3 meses.⁷

**Implicação:** engenharia boa não ganha o jogo sozinha. Quem ganha tem orderflow exclusivo,
latência de ponta, ou um edge de nicho não-óbvio.

---

## 2. Tiers de competidores — onde o ZEUS se encaixa

| Tier | Exemplo real | ZEUS? |
|---|---|---|
| **Elite integrada verticalmente** | Wintermute, SCP (builder próprio + orderflow exclusivo; >50% da receita CEX-DEX) | ❌ Muito longe |
| **Searcher solo de elite** | jaredfromsubway.eth (~$2M em 2024, Rust, infra privada, sandwiches multi-layer) | ❌ Longe |
| **Profissional de nicho** | Bots dedicados de liquidação Aave/Compound (milhares de liquidações/endereço) | 🟡 Mira aqui, sem a infra |
| **Bem-construído, não-comprovado** | **← ZEUS** | ✅ |
| **Hobby / retail copy-paste** | Flashbots `simple-arbitrage`, `mev-templates` | ⬆️ ZEUS está acima |

Frameworks open-source de referência: `flashbots/simple-arbitrage` (didático), `simple-blind-arbitrage`
(backrun atômico via MEV-Share, intermediário), `paradigmxyz/artemis` (base "séria" em Rust),
`rusty-sando` (sandwich Rust+Huff, **arquivado 2023** — referência, não produção).

---

## 3. Hierarquia de edge — o que os top usam pra ganhar

Ordem de importância (do mais decisivo pro menos):

1. **Orderflow privado / integração com builder** — o edge migrou de "ser rápido no mempool
   público" pra "ter acesso exclusivo a orderflow". MEV-Share devolve ~90% do MEV ao usuário;
   searcher sem orderflow compete só nas sobras.⁸
2. **Latência (Rust/C++ + co-location)** — Rust é padrão de facto em short-tail. "400ms de
   latência de node custou 40% das capturas"; "50ms decide backrun lucrativo vs. perdido"; bots
   acima de ~200ms capturam muito menos.⁹
3. **Mempool premium** (bloXroute/Blocknative) — feed mais rápido que RPC público; vantagem de
   milissegundos na detecção.¹⁰
4. **ML/estatística** — otimização de bidding/timing. **É camada de cima, não fundação** — sem os
   de baixo, é otimização de margem zero.¹¹

**ZEUS hoje:** não tem (1), não tem (2) — usa TS, não Rust; não tem (3) — usa dRPC/RPC público;
tem a *arquitetura* de bundle/bribe pronta mas sem orderflow exclusivo. Tem instrumentação pra
construir (4) (camada OIE: scoring, EV competitor-aware).

---

## 4. Base L2 — mecânica e o que muda o jogo

- **Sequencer único e centralizado (Coinbase). Sem mempool público tradicional.** → sandwiches
  raros/inviáveis (sem mempool pra observar vítimas). Viável: **arb atômica, blind backrun,
  liquidações, stat arb**.¹²
- **Ordenação por priority-fee (PGA), não FCFS puro** — gas fee primeiro, tempo de chegada como
  desempate.¹²
- **Flashblocks (jul/2025):** blocos de 2s divididos em **10 mini-blocos de 200ms**; PGA roda a
  cada 200ms e a ordem trava quando o flashblock é transmitido. → **aumenta a pressão de
  latência** mesmo na Base. Exemplo: na creator-coin do Jesse Pollak, snipers tiraram **$1,3M**
  explorando a visibilidade dos flashblocks.¹³
- **Saturação:** nov/2024, quase todo throughput novo da Base foi comido por **spam de bots**.⁴
- **Sequencer central — misto pro retail:** a favor (sem PBS/builders dominando, sem guerra de
  sandwich, fees baixos); contra (**latência vira o fator dominante** — quem está co-located perto
  do sequencer frontruns; risco de downtime — Base caiu fev/2025; e a tendência de **OEV capture**
  abaixo).

### ⚠️ 4.1 OEV capture nas liquidações — o achado decisivo

A tese da Paradigm *"Priority Is All You Need"* (jun/2024) permite que protocolos em OP Stack
capturem o MEV da própria liquidação via leilão on-chain de priority fee. **Está se espalhando.**

| Alvo (na Base) | Status OEV | Edge pro liquidador externo NOVO |
|---|---|---|
| **Aave V3 — ativos principais** (ETH, BTC, USDC) | **Chainlink SVR ativo** (Base entre as 5 chains live pós-aquisição Atlas/FastLane, jan/2026); recaptura ~80-90% | **Quase nulo** — não priorizar |
| **Aave V3 — long-tail / fora do SVR** | Possivelmente ainda aberto | Marginal e encolhendo |
| **Compound III** | SVR/Atlas citado como integração live | **Provavelmente fechado** — checar mercado a mercado |
| **Moonwell** | **MEV tax / OEV auction on-chain** desde fev/2025; captura ~99% | **Praticamente nulo** |
| **Morpho Blue** (maioria dos mercados) | **Aberto/permissionless**; LIF (~5%) inteiro pro liquidador; OEV capture é opt-in e pouco adotado | **EDGE REAL existe** — adversário é competição de bots, não o protocolo |

**Chainlink SVR:** split padrão ~60% protocolo / 40% Chainlink; recaptura média >80% (picos >90%);
>99% de market share entre soluções OEV; live em Ethereum, Arbitrum, **Base**, BNB, HyperEVM;
protocolos Aave/Compound/Venus.¹⁴

**Veredito:** dos motores de liquidação do ZEUS, **Morpho Blue é o único com edge não-comido na
Base**. Aave V3, Compound III e Moonwell estão fechados/fechando por OEV capture. Revisar a
premissa de cobertura Aave/Compound/Moonwell do pipeline antes de gastar mais calibração neles.

---

## 5. TypeScript+viem vs. Rust — onde o stack do ZEUS joga

- **Rust é padrão de facto pra short-tail MEV competitivo.** Consenso da comunidade: *"dá pra
  fazer um bot MEV em TS, mas simplesmente não vai ser competitivo"* em jogos de latência.¹⁵
- **TS+viem é viável onde o ZEUS mira:** liquidações (gargalo é descoberta/cálculo, não o fio) e
  arb atômica não disputada no microssegundo. **TS perde** em sandwich/backrun/arb latency-race.¹⁵
- **Liquidações:** peso pende pra **descoberta + ser o primeiro a submeter** (detectar HF < 1 antes
  dos outros). Há espaço pra ganhar no cálculo/cobertura, não só no fio.¹⁵
- **Backrun:** **fortemente latency-sensitive** ("50ms = backrun perdido"). É onde TS tem
  **desvantagem estrutural**. Se virar motor sério (Sprints 4/5), o hot-path precisaria de Rust
  (revm/Alloy) ou aceitar competir só onde latência não decide.¹⁵

**Conexão com a Etapa B (EV gate no backrun):** o gate competitor-aware adicionado é *mais* valioso
justamente porque o ZEUS é estruturalmente lento em backrun — ele ajuda a **não entrar em corridas
que perderia**. Mas nenhum gate transforma TS em competitivo no hot-path; é mitigação, não solução.

---

## 6. Scorecard do ZEUS — nota por eixo

| Eixo | Nota | Justificativa |
|---|---|---|
| **Engenharia / arquitetura de código** | **7,5** | Modular, audit interno, 53 testes, camada de inteligência (DuckDB, scoring, reconciliação PnL) que a maioria do retail não tem. |
| **Seleção de estratégia** | **6,5** | 3 motores descorrelacionados é inteligente; liquidação + medium-cap são nichos menos dominados. Mas Base cross-DEX é concentrado e liquidação Aave/Compound está sendo comida por OEV. |
| **Infra competitiva / latência** | **3,5** | Calcanhar de Aquiles. TS (não Rust), sem mempool premium, sem orderflow privado, sem builder integration. |
| **Maturidade operacional** | **2,0** | Nunca rodou com capital real. Edge não comprovado. Operação solo. |
| **Prontidão pra lucro real** | **3,0** | Blocker #1 ("edge") confirmado pela pesquisa como o problema central. |

**Composta como competidor: ~4,5/10.** Como software: ~7,5/10.

---

## 7. Implicações estratégicas / ações recomendadas

1. **Pivotar o liquidator pra Morpho Blue na Base** — único motor de liquidação com edge não-comido
   por OEV. Tratar Aave V3 / Compound III / Moonwell como "captura de sobras" em ativos ainda fora
   do SVR (janela que fecha).
2. **No Morpho, o adversário é latência/gas-war contra outros bots** (o próprio Morpho mantém um
   liquidation-bot open-source) — não o protocolo. Avaliar honestamente se TS aguenta essa corrida.
3. **Não brigar em sandwich/CEX-DEX** — arena dos integrados verticais (validado pela pesquisa).
4. **Backrun (Sprints 4/5):** se for sério, planejar hot-path em Rust ou restringir a cenários onde
   latência não decide. O EV gate da Etapa B mitiga, não resolve.
5. **Antes de capital real:** o edge precisa ser comprovado em números (DRY_RUN → mainnet pequeno),
   não assumido. Nenhuma linha de código pula essa etapa.

---

## Fontes

1. [1023jack — Polymarket bots profitability](https://1023jack.com/market/are-polymarket-trading-bots-actually-profitable-the-math-behind-2026-s-predictio/)
2. [BTCS Analyst Primer — Ethereum & MEV (top 5 = 80%)](https://www.btcs.com/wp-content/uploads/2025/03/Analyst-Primer-Ethereum-and-MEV-March-2025-vF.pdf)
3. [arXiv 2507.13023 — Measuring CEX-DEX Extracted Value & Searcher Profitability](https://arxiv.org/html/2507.13023v1)
4. [Flashbots Collective — L2 MEV: intent solvers vs native arb (Base case study)](https://collective.flashbots.net/t/l2-mev-are-intent-based-solvers-killing-native-on-chain-arbitrage-a-base-case-study/5667)
5. [arXiv 2412.18074 — Oligopoly in Ethereum Block Building](https://arxiv.org/html/2412.18074v2)
6. [Flashbots — MEV and the Limits of Scaling](https://writings.flashbots.net/mev-and-the-limits-of-scaling)
7. [dev.to — The Arbitrage Bot Arms Race (FlashArb in production)](https://dev.to/chronocoders/the-arbitrage-bot-arms-race-what-we-learned-running-flasharb-in-production-10ij)
8. [Flashbots — Illuminate the Order Flow](https://writings.flashbots.net/illuminate-the-order-flow) · [MEV-Share Intro](https://docs.flashbots.net/flashbots-mev-share/introduction)
9. [Dwellir — MEV Bot Infrastructure (RPC, latency, cost)](https://www.dwellir.com/blog/mev-arbitrage-bot-infrastructure) · [Paradigm — Artemis](https://www.paradigm.xyz/2023/05/artemis)
10. [bloXroute — Data Streams](https://bloxroute.com/products/data-streams/) · [MEVlink acquisition](https://bloxroute.com/pulse/even-faster-mempool-data-with-mevlink-acquisition/)
11. [IACR 2023/1281 — ML for Bidding in MEV Auctions](https://eprint.iacr.org/2023/1281.pdf) · [arXiv 2510.14642 — RL for MEV on Polygon](https://arxiv.org/html/2510.14642)
12. [Base Docs — Block Building](https://docs.base.org/base-chain/network-information/block-building) · [Coinlive — Decoding L2 MEV](https://www.coinlive.com/news/decoding-l2-mev-sequencer-workflow-and-mev-data-analysis)
13. [OAK Research — Flashblocks](https://oakresearch.io/en/analyses/innovations/flashblocks-towards-ultra-fast-layer2-ev-ms) · [CoinDesk — snipers $1.3M Jesse Pollak creator coin](https://www.coindesk.com/business/2025/11/21/snipers-made-usd1-3m-on-jesse-pollak-s-creator-coin-debut-on-base) · [arXiv 2506.01462 — Revert-Based MEV on Fast-Finality Rollups](https://arxiv.org/pdf/2506.01462)
14. [Chainlink — Smart Value Recapture (SVR)](https://chain.link/article/smart-value-recapture) · [Aave integra SVR (PRNewswire)](https://www.prnewswire.com/news-releases/aave-integrates-chainlink-svr-on-ethereum-mainnet-to-recapture-liquidation-mev-and-increase-protocol-revenue-302414191.html) · [Chainlink adquire Atlas/FastLane (Base, Arbitrum, BNB, HyperEVM)](https://www.prnewswire.com/news-releases/chainlink-acquires-atlas-by-fastlane-to-increase-revenue-for-defi-by-expanding-svr-to-new-ecosystems-302667894.html) · [Aave Gov — SVR multi-network (Base/Arbitrum)](https://governance.aave.com/t/arfc-aave-chainlink-svr-multi-network-expansion-base-arbitrum/24241) · [Morpho — Liquidations](https://docs.morpho.org/learn/concepts/liquidation/) · [Morpho forum — OEV recapture by Oval](https://forum.morpho.org/t/oev-recapture-on-morpho-blue-markets-by-oval/612) · [Moonwell — Capturing OEV](https://forum.moonwell.fi/t/capturing-oev-in-the-moonwell-protocol/1423) · [Paradigm — Priority Is All You Need](https://www.paradigm.xyz/2024/06/priority-is-all-you-need)
15. [Paradigm — Artemis (Rust framework)](https://www.paradigm.xyz/2023/05/artemis) · [Solid Quant — How fast is your MEV bot? (JS/Python/Rust)](https://medium.com/@solidquant/how-fast-is-your-mev-bot-comparing-javascript-python-rust-72376a820291) · [Coinmonks — The DeFi liquidation game](https://medium.com/coinmonks/the-defi-liquidation-game-aaef5c0b903d) · [Flashbots Docs — Rust Provider](https://docs.flashbots.net/flashbots-auction/libraries/rust-provider)

> **Limites desta pesquisa:** alguns números de latência (200ms/50ms/400ms→40%) vêm de blogs de
> infra, não de papers peer-reviewed — tratar como ordem de grandeza. Algumas páginas-chave
> (Solid Quant, DeFi liquidation game) retornaram 403 no fetch; os fatos vieram de snippets de
> busca. Valores de lucro de searchers são por endereço/período, não lifetime.
