# Viabilidade — ZEUS como filler UniswapX na Base (pivô do Motor 2)

> Pesquisa + scan do código, jun/2026. Avalia transformar o Motor 2 (arb cross-DEX) em **filler de
> intent na UniswapX (Base)**. Doc de decisão — **sem código ainda**. Honestidade > otimismo cego.
> Contexto competitivo em `docs/COMPETITIVE_ANALYSIS_2026-06.md` (§ Motor 2).

---

## TL;DR

- **Construir é barato e bem-encaixado:** ~**60-70% do nosso código já serve** (quoting multi-DEX,
  simulação, executor atômico, flashloan, gas/relays). O que falta (~30-40%) é a "casca" de solver:
  receber ordens + contrato `IReactorCallback` + lógica de fill.
- **EIP-170 OK:** o callback vai no `ZeusArbExecutor` (~16,3 KB, folga ~8 KB), **não** no `ZeusLiquidator`
  apertado. Cabe sem contrato satélite.
- **O edge de mercado é fino e NÃO-provado:** margem de filler é **1-5 bps**, e os competidores são
  **market makers com inventário** — que preenchem do próprio livro sem pagar spread de DEX. Nosso modelo
  (sourcing via DEX) é o tipo de filler **mais fraco** nos pares grandes.
- **Onde podemos ganhar = long-tail:** pares exóticos/medium-cap onde **nenhum MM tem inventário** e
  *todos* precisam de sourcing em DEX. Aí o nosso multi-DEX + flashloan compete de igual pra igual.
  (Mesma lógica do edge long-tail do Morpho.)
- **Dá pra medir ANTES de construir:** os fills da UniswapX são transparentes on-chain → observamos quais
  pares na Base são preenchidos via DEX-sourcing e a que margem, sem escrever uma linha de contrato.

**Recomendação:** **medir primeiro** (F0), construir só se o long-tail mostrar margem real.

---

## 1. Por que UniswapX e não CoW (a bifurcação de custo)

Virar "solver" são dois caminhos opostos em barreira de entrada:

| | **CoW Protocol** | **UniswapX na Base** |
|---|---|---|
| KYC | Sim (beneficial owners + passaportes) | **Não** |
| Bond / capital travado | Sim (COW, slashable) | **Não** |
| Aprovação | Voto da CoW DAO + allowlist | **Permissionless** |
| RFQ (serviço <500ms) | — | **Não usa RFQ no L2** (só Filler) |
| Contrato próprio | Não (usa "driver") | Sim (`IReactorCallback`) |
| **Custo de entrada** | **Alto** (meses + capital + KYC) | **Baixo** (infra + 1 contrato) |

Na Base, a UniswapX dispensa o RFQ (parametriza por preço de AMM, leilão holandês) → **a barreira mais
pesada some**. É o único caminho realista pra um operador solo. A CoW fica pra um momento muito mais
maduro (empresa + capital + equipe), ou nunca.

---

## 2. Mapa de reúso — o que já temos (~60-70%)

O scan do código confirmou que o **miolo de um filler já existe e é production-grade**:

| Peça do filler | Temos? | Onde (reuso) |
|---|---|---|
| Cotar entre 6 DEX + melhor rota | ✅ 100% | `packages/strategy/src/opportunities/quoteFanout.ts` + `dex-adapters` (`quoteUniswapV3/Aerodrome/Slipstream/UniswapV2` + forks Pancake/Sushi) |
| Rota multi-hop (via WETH/USDC) | ✅ | `packages/dex-adapters/src/uniswap-v3/multiHopQuoter.ts` |
| Simular via eth_call (gate atômico) | ✅ 100% | `packages/strategy/src/executor/simulator.ts` (`simulateArbitrage`) |
| Executar N swaps token-in→token-out | ✅ 100% | `contracts/src/ZeusArbExecutor.sol` `_executeSwaps` (loop `SwapStep[]`, encadeia com `amountIn=0`) |
| Montar SwapStep[] a partir de um par | ✅ | `packages/strategy/src/executor/txBuilder.ts` (`buildSwapSteps`) |
| Flashloan multi-fonte 0% | ✅ 100% | `packages/strategy/src/executor/flashSourceSelector.ts` (Morpho→Balancer→Aave) |
| Gas oracle EIP-1559 | ✅ 100% | `packages/execution-utils/src/gasOracle.ts` |
| Relays / bundle / mempool fallback | ✅ 100% | `apps/backrun-engine/src/bundling/relayRouter.ts` |
| Chave/conta/dispatch | ✅ 100% | viem account + `apps/mis-scanner/src/execution/arbDispatcher.ts` |

---

## 3. O que falta (~30-40% novo) — a "casca" de solver

| Peça nova | Esforço | Nota |
|---|---|---|
| **Ingestão de ordens** — serviço que faz polling das ordens UniswapX abertas na Base (rate-limit 6 rps) | Médio | Não existe — hoje varremos pools, não recebemos ordens. App novo leve. |
| **Order → plano de swap** — `{tokenIn, tokenOut, amountIn, deadline}` → rota | Baixo | **Reusa `buildSwapSteps`**; mais cola que código. |
| **Contrato Executor `IReactorCallback`** — reactor entrega o token de entrada, chama nosso callback, fazemos o swap (`_executeSwaps`), aprovamos o token de saída de volta pro reactor | Médio | Mesmo padrão dos nossos callbacks de flashloan. **Mudança de contrato → redeploy testnet.** |
| **Lógica de "quando preencher"** — a ordem holandesa decai de preço; preenchemos quando vira lucro | Médio | Reusa simulação + EV gate; falta a máquina de estado do leilão. |
| **Validação de assinatura / settlement** | Baixo | EIP-712 padrão (viem). |

---

## 4. Infra necessária + custo

| Item | Custo |
|---|---|
| **App filler** (polling + intent→swap + fill) | Roda no **Fly.io que já temos**; serviço leve. ~$0 extra relevante. |
| **Callback no `ZeusArbExecutor`** | 1 mudança + **redeploy testnet** (regra de sempre). EIP-170 OK (folga ~8 KB). |
| **Capital** | **Nenhum travado** — o reactor dá o token de entrada no callback (estilo pre-liquidation); ou flashloan 0%. Atômico → falha só custa gas. |
| **Bond / KYC / governança** | **Zero** (permissionless na Base). |

**"É caro demais?" — Não.** O custo real é **tempo de engenharia** (~30-40% de código novo), não
dinheiro/capital/burocracia.

---

## 5. Economia honesta (o risco real não é construção, é mercado)

- **Margem de filler: 1-5 bps** em pares grandes ("alguns dólares" por fill num swap de ~US$ 5k).
- **Fill rate 99,5%** — muita competição; ordens quase sempre são preenchidas por alguém.
- **Base = 40-50% da atividade da Uniswap, >50% dos usuários** → **o fluxo existe e é grande**.
- **Competidores = market makers profissionais com inventário** + pricing de baixa latência.

**A desvantagem estrutural (a verdade incômoda):** um MM que segura os dois tokens preenche do **próprio
inventário**, instantâneo, **sem pagar spread de DEX**. Nós, fazendo **sourcing via DEX**, pagamos o
spread + gas. Em margem de 1-5 bps, **o inventário ganha quase sempre** nos pares grandes. Seríamos o
tipo de filler mais fraco — justamente onde a competição é mais profissional.

**Onde isso se inverte = long-tail.** Em tokens exóticos/medium-cap, **nenhum MM segura inventário** →
*todo* filler precisa de sourcing em DEX. Aí o nosso **multi-DEX routing + flashloan + simulação** compete
de igual pra igual (ou melhor, porque cobrimos 6 DEX). **É o mesmo padrão do edge long-tail do Morpho:
ganhar onde os profissionais não têm vantagem estrutural.**

---

## 6. Validação barata ANTES de construir (o ponto-chave)

Os fills da UniswapX são **transparentes on-chain** (dá pra rastrear no Etherscan/Dune: o token de
entrada, os hops de sourcing do filler, e a margem exata que ele ganhou). Isso permite **medir o risco
de mercado sem escrever contrato**:

> Observar ~1-2 semanas de fills da UniswapX na Base e responder:
> 1. Quais pares são preenchidos via **DEX-sourcing** (não inventário)? → esses são os nossos alvos.
> 2. Qual a **margem média** nesses fills long-tail? Sobra acima do nosso gas?
> 3. Qual a **frequência** (quantos fills/dia endereçáveis)? → dimensiona o prêmio.
> 4. Quem são os fillers atuais nesses pares? Quão dominado já está?

Se os números do long-tail forem bons, construir. Se não, **economizamos a empreitada inteira**.

---

## 7. Esboço de fases (se for construir)

- **F0 — Medir (sem código):** análise on-chain dos fills UniswapX na Base (§6). Decide go/no-go.
- **F1 — Contrato:** entry `IReactorCallback` no `ZeusArbExecutor` (reusa `_executeSwaps`) + fork test +
  **redeploy testnet** (medir EIP-170 — esperado seguro).
- **F2 — App filler:** novo `apps/uniswapx-filler` (ou módulo no mis-scanner) — polling de ordens +
  intent→swap (reusa `buildSwapSteps`) + `simulateArbitrage` + dispatch. **Execução OFF por default**
  (mesmo padrão armado-mas-travado do Motor 2).
- **F3 — DRY_RUN:** observar quais ordens preencheríamos com lucro (simulação), sem enviar. Calibrar.
- **F4 — Ligar:** só com edge provado no DRY_RUN, em testnet/fork primeiro, capital pequeno depois.

---

## 8. Ressalvas + recomendação

- **Não foge da competição — relocaliza.** Trocamos "caçar spread nas pools" por "disputar fill de
  ordens roteadas". Os profissionais estão nos dois lugares.
- **A vantagem real:** acessamos um **fluxo que o nosso pool-scanner não enxerga** (ordens que o usuário
  mandou pra UniswapX). É flow capturado, melhor que migalha de mercado aberto.
- **Latência ainda pesa** (preencher leilão holandês é corrida), mas é menos brutal que backrun de 50ms.
- **Reúso de 60-70% reduz o risco de CONSTRUÇÃO, não o de MERCADO.** Construção barata ainda é tempo
  gasto se o mercado não pagar.

**Recomendação final:** o filler UniswapX-Base é a **expansão mais barata e bem-encaixada do Motor 2**,
e o **long-tail** é um nicho plausível pro nosso stack. Mas **fazer a F0 (medição on-chain) ANTES de
qualquer código** — é barata, honesta, e pode nos poupar a empreitada. Prioridade abaixo do Motor 1
(Pre-Liquidation), que é o edge mais concreto e já em andamento.

---

## Anexo A — F0: como medir no Dune (passo a passo, sem construir o bot)

> **Objetivo:** responder, com dado real da Base, *"existe long-tail onde fillers buscam liquidez em
> DEX (não inventário) com margem positiva?"* — ANTES de escrever qualquer contrato/app.
> **Quem roda:** Antigravity no PC (o cloud não tem login no Dune nem RPC da Base). Aqui só preparamos.

### Passo 0 — o que o Antigravity confirma ANTES de rodar (3 coisas)
1. **Endereço(s) do Reactor UniswapX na Base** (Basescan — pode haver mais de um: `ExclusiveDutchOrderReactor`,
   `V2DutchOrderReactor`, `V3DutchOrderReactor`, `PriorityOrderReactor`). _(A página oficial de deployments
   bloqueou o fetch do cloud; confirmar no Basescan/GitHub Uniswap/UniswapX.)_
2. **Nome exato da tabela decodificada no Dune** — abrir o contrato Reactor no Dune → aba "Decoded events" →
   achar o evento `Fill`. O namespace costuma ser algo como `uniswap_x_base.<Reactor>_evt_Fill` (CONFIRMAR;
   substituir nos `<<...>>` abaixo).
3. **`dex.trades` cobre as DEX da Base** que os fillers usam (Uniswap/Aerodrome/etc.) — geralmente sim.

### Passo 1 — como rodar no Dune
1. Criar conta grátis em `dune.com` → **New Query** → selecionar engine **DuneSQL**.
2. Colar a query → **Run** → ver a tabela.
3. Salvar (fica reproduzível + linkável). Repetir pra cada query abaixo.

### Query A — contexto: quem preenche na Base e quanto (14 dias) · runnable
```sql
-- Confirma que o fluxo existe + concentração (quem domina)
SELECT
  filler,
  count(*)                AS fills,
  count(distinct swapper) AS usuarios
FROM <<uniswap_x_base.ExclusiveDutchOrderReactor_evt_Fill>>   -- << confirmar nome (Passo 0.2)
WHERE evt_block_time > now() - interval '14' day
GROUP BY 1
ORDER BY fills DESC
```

### Query B — a F0: classifica DEX-sourced × inventário · draft (refinar margem no Passo 2)
```sql
-- Regra: se na MESMA tx do fill houve swap em DEX → o filler buscou liquidez (competimos de igual).
-- Se NÃO houve → preencheu do próprio inventário (não competimos).
WITH fills AS (
  SELECT evt_block_time AS t, evt_tx_hash AS tx, filler, swapper
  FROM <<uniswap_x_base.ExclusiveDutchOrderReactor_evt_Fill>>   -- << confirmar nome
  WHERE evt_block_time > now() - interval '14' day
),
dex AS (
  SELECT tx_hash AS tx, count(*) AS hops, sum(amount_usd) AS sourced_usd
  FROM dex.trades
  WHERE blockchain = 'base' AND block_time > now() - interval '14' day
  GROUP BY 1
)
SELECT
  CASE WHEN d.tx IS NULL THEN 'inventario' ELSE 'dex_sourced' END AS fonte,
  count(*)              AS fills,
  count(distinct f.filler) AS fillers,
  round(sum(d.sourced_usd), 0) AS volume_sourced_usd
FROM fills f
LEFT JOIN dex d ON f.tx = d.tx
GROUP BY 1
ORDER BY fills DESC
```
> **Passo 2 (margem, refinamento):** o evento `Fill` **não carrega os valores** da ordem — pra calcular a
> margem é preciso juntar os **transfers ERC20 da mesma tx** (token que saiu do `swapper` = entrada; token que
> entrou no `swapper` = saída). Margem ≈ `valor_entregue_ao_swapper − sourced_usd − gas_usd`. Adicionar
> esse join (via `tokens.transfers`/`erc20_base.evt_Transfer` por `tx_hash`) depois que A e B rodarem.
> Agrupar por **par de token** pra achar o long-tail.

### Passo 3 — tabela de resultados (MEDIDO via Dune API · 2026-06-26 · janela 14d)

> **Reactors UniswapX na Base (Passo 0.1 — CONFIRMADO on-chain):** a topic0 do `Fill` colide entre
> protocolos → filtrar pelos reactors REAIS (vanity `0x000000…`, ✅ bytecode on-chain):
> **V2DutchOrderReactor `0x000000001Ec5656dcdB24D90DFa42742738De729`** (396 fills/14d, o dominante) +
> **V3DutchOrderReactor `0x000000008a8330B5d1F43A62Bf4C673A49f27ba0`** (113 fills/14d, novo, deploy 2026-05-07).
> Confirma a ressalva do doc: **há >1 reactor → UNION obrigatório.** Medição feita via `base.logs`
> (topic0 `Fill` = `0x78ad7ec0…`), sem depender de tabela decodificada.

| Métrica | Valor MEDIDO |
|---|---|
| Total de fills na Base (14d) | **~508** (V2+V3 UniswapX; 396 V2 + 113 V3; +11 em 2 reactors minúsculos) |
| % dex-sourced vs inventário | **80,5% dex-sourced** (409 fills, **$2,6M** sourced) vs **19,5% inventário** (99 fills) |
| Top 5 fillers (concentração %) | **~72,5%** (líder 26,5% · 15,7% · 13,2% · 11,0% · 6,1%) — 18 fillers no dex-sourced |
| Pares long-tail dex-sourced | **existem e são reais** (VIRTUAL, NOCK, VVV, TIBBIR, CLANKER, AERO, GITLAWB, CENTRY, TIG…) mas **1-4 fills/dia por par** |
| Fills/dia endereçáveis (dex-sourced, long-tail) | **agregado ~25-30/dia** (excluindo blue-chips USDC-WETH 9,6 · cbBTC-USDC 5,4 · cbBTC-WETH 5,0); **nenhum par long-tail ≥10/dia** |
| Margem média no long-tail (bps) | ✅ **MEDIDA — Passo 2 abaixo.** Blue-chip ~5 bps; long-tail **20–120 bps median** (paga prêmio real) |
| Link da(s) query(s) Dune | dune.com/queries/**7819981** (reactors) · /**7819995** (dex×inv) · /**7820004** (por par) · /**7820045** (fillers) · /**7821823** (margem/par) |

### Passo 2 — MARGEM MEDIDA por par (Dune API · 2026-06-26 · 14d · query 7821823)

> Método: pra cada fill dex-sourced, somei os transfers ERC20 da MESMA tx — `valor que o swapper
> ENTREGOU − valor que recebeu` = margem bruta do filler. 115 fills com preço USD nos dois lados
> (long-tail sem preço no Dune ficou de fora — ressalva conhecida). **$12,9k de margem bruta total
> extraída por TODOS os fillers nesses pares em 14d (~$925/dia).**

| Par (amostra) | fills/14d | ordem média | **margem median (bps)** | leitura |
|---|---|---|---|---|
| USDC→ETH (blue) | 19 | $12.295 | **5,2** | apertado — competição de MM |
| USDT→ETH (blue) | 6 | $4.499 | **12,5** | blue, ainda fino |
| cbBTC→USDC (blue) | 19 | $15.585 | **13,0** | blue com mais folga |
| CLANKER→ETH | 11 | $2.670 | **20,0** | long-tail paga mais |
| USDC→VVV | 8 | $48.239 | **26,2** | ordens grandes + prêmio |
| USDC→cbBTC | 5 | $14.931 | **28,3** | |
| VVV→USDC | 3 | $11.565 | **81,5** | |
| AERO→USDC | 2 | $13.380 | **80,1** | |
| USDC→AERO | 4 | $5.568 | **121,5** | |
| USDC→DRB | 2 | $2.621 | **110,4** | |
> Alguns pares (VIRTUAL, BRETT) deram median negativo = **ruído de preço de token ilíquido no Dune**
> (preço do token na hora do fill impreciso → USD dos dois lados não bate), não fill com prejuízo real.
> A mediana (robusta a outlier) dos pares com preço confiável é o sinal: **long-tail 20–120 bps.**

**Conclusão do Passo 2:** a margem **NÃO é o bloqueador** — o long-tail paga **4–20× mais que blue-chip**
e cobre o gás da Base (~centavos) com folga enorme. O número decisivo que faltava veio **positivo**.

### Passo 3.1 — Veredito F0 (honesto, vs critério travado no Passo 4)

**🟡 Tende a NO-GO no critério ESTRITO — mas com surpresa positiva e 1 número decisivo faltando.**

- ✅ **Surpresa boa:** **80% dos fills na Base são dex-sourced** (não inventário) — o OPOSTO do medo da §5.
  O fluxo onde competimos de igual existe e é grande ($2,6M sourced/14d).
- ✅ **Long-tail existe:** dezenas de pares medium-cap/exóticos (VIRTUAL, NOCK, VVV, CLANKER…) preenchidos via DEX.
- ❌ **Frequência por par REPROVA o critério:** o gate era **≥10 fills/dia POR par** em ≥5 pares long-tail.
  Na real, o long-tail roda **1-4 fills/dia por par** (o máximo long-tail é VIRTUAL-WETH 4,4/dia; nem o
  blue-chip USDC-WETH bate 10, fica em 9,6). **Nenhum par long-tail chega a 10/dia.** O prêmio está
  **espalhado fino** em muitos pares de baixa frequência → um filler especialista-por-par não enche.
- ✅ **Margem (bps) — MEDIDA (Passo 2) e POSITIVA:** long-tail 20–120 bps median vs ~5 bps blue-chip.
  Cobre o gás da Base com folga. O número decisivo veio bom — o pior medo da §5 (margem < gás) está afastado.

### Passo 3.2 — VEREDITO FINAL (com a margem medida) — 2026-06-26

**🟡 VIÁVEL mas MODESTO — construir só como 2º fluxo, depois do Motor 1, se Humberto quiser.**

O quadro fechou com os 2 números na mão (frequência + margem):

| Dimensão | Resultado | Leitura |
|---|---|---|
| Fluxo dex-sourced existe? | ✅ 80% dos fills, $2,6M/14d | grande e real |
| Margem cobre o gás? | ✅ long-tail 20–120 bps (gás ~centavos) | **sim, com folga** |
| Frequência por par | ❌ 1–4 fills/dia (nenhum ≥10) | **fino — o limitador** |
| Agregado endereçável | 🟡 ~25–30 fills/dia (multi-par) | modesto |
| Concorrência | 18 fillers, top-5 = 72% | disputado |

**Síntese honesta:** a economia POR FILL é boa (margem clara > gás). O limitador é **volume**: o prêmio
está espalhado fino em muitos pares de baixa frequência. O total bruto extraído por TODOS os fillers no
dex-sourced é ~$925/dia; nossa captura realista (fração, contra 18 concorrentes) seria **dezenas de
dólares/dia** no começo — real, mas pequeno perto do esforço (~30-40% de código + redeploy).

**Recomendação:** **NÃO é prioridade.** O Motor 1 (pré-liquidação) é o edge mais concreto e já construído.
O filler UniswapX vira candidato a **2º fluxo descorrelacionado** DEPOIS do Motor 1 estar faturando — e
mesmo assim como filler **multi-par** (agregando o long-tail), nunca especialista por-par. Engavetar a
construção agora; reabrir quando quisermos diversificar a renda. A medição custou ~zero e nos poupou
construir um app/contrato pra um retorno que hoje não justifica a fila.

### Passo 4 — critério go/no-go (FIXAR antes de olhar os números)
- ✅ **GO (vale construir):** ≥ **5 pares** long-tail dex-sourced com **margem líquida > 3 bps** em
  ≥ **10 fills/dia** cada. _(Números iniciais — ajustar com o Humberto, mas travar ANTES de ver o resultado.)_
- ❌ **NO-GO (engaveta):** quase tudo inventário, OU margem < gas no long-tail, OU volume irrelevante.
- 🟡 **Talvez:** sinais mistos → repetir com janela maior (30d) antes de decidir.

### Ressalvas honestas da medição
- "Inventário" é **aproximação** (fill sem swap na mesma tx). Um filler poderia sourcing em tx/bloco separado
  (raro num fill atômico, mas anotar se aparecer padrão estranho).
- `amount_usd` pode faltar pra tokens long-tail sem preço no Dune → esses fills aparecem com volume nulo;
  tratar à parte (são justamente candidatos a long-tail — vale inspecionar manualmente alguns).
- Confirmar se há **mais de um Reactor** ativo na Base e unir todos (UNION ALL) pra não subcontar.

---

## Fontes

- **Solver/filler reqs:** [UniswapX — Filler Overview (`IReactorCallback`)](https://docs.uniswap.org/contracts/uniswapx/fillers/filleroverview) · [Filling on Mainnet (polling, 6rps)](https://docs.uniswap.org/contracts/uniswapx/fillers/mainnet/createfiller) · [Become a Quoter (RFQ só em L1)](https://docs.uniswap.org/contracts/uniswapx/fillers/mainnet/becomequoter) · [CoW — Joining the Solver Competition (KYC/bond)](https://docs.cow.fi/cow-protocol/tutorials/solvers/onboard)
- **Economia:** [Eco — What is UniswapX 2026 (margem 1-5 bps, fillers = MM com inventário)](https://eco.com/support/en/articles/11852773-what-is-uniswapx-2026-guide) · [Uniswap blog — Quantifying Price Improvement in OFAs](https://blog.uniswap.org/UniswapX_PI.pdf) · [Uniswap stats 2026 (Base 40-50%)](https://coinlaw.io/uniswap-statistics/)
- **Reúso de código:** scan interno do repo (`quoteFanout`, `simulateArbitrage`, `ZeusArbExecutor._executeSwaps`, `flashSourceSelector`, `gasOracle`, `relayRouter`).

> **Limites:** margens 1-5 bps e "Base 40-50%" vêm de guias/stats, não de dados on-chain auditados — a
> F0 (medição direta) substitui isso por número real. % de reúso (60-70%) é estimativa do scan, a
> confirmar na implementação.
