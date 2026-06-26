# Recon de Competidores — Pre-Liquidation Morpho na Base (2026-06-26)

> Inteligência on-chain dos top-3 liquidadores de pré-liquidação na Base. Coletada via RPC (Alchemy)
> + `cast` + Dune API. **Alimenta a OIE** (`senderRegistry`/`CompetitorResolver`) — não é throwaway.
> Objetivo: entender por que estão no trono, o que copiar, e onde está a nossa porta de entrada.

## TL;DR — o trono está na INFRA, não no contrato

- Os 3 contratos executores são **padrão** (preLiquidate → swap → repay). O #1 **nem usa flashloan nem
  multi-DEX**. **Nosso contrato já iguala/supera** (temos multi-DEX; eles fazem single-hop).
- O #1 domina (55%) com **gás modesto (~1,3 gwei) + 44 EOAs em paralelo + velocidade de monitoramento**.
  O #3 paga **44 gwei** (35× mais) e só pega 7,5% → **lance de gás NÃO destrona**.
- **Mercado recém-aquecido:** toda a atividade dos top-3 é dos **últimos ~30 dias** (surto de junho/2026);
  o contrato do #1 tem **25 dias**. Trono **fresco e contestável** — infra boa toma share rápido.
- **Alavanca pra sair da cauda = INFRA** (latência de detecção do `preLltv` + pool de senders paralelos),
  não copiar contrato. Isso é **evidência pra revisitar a decisão de wallet-pool** (ver memória
  `project_zeus_evm_wallet_pool_decision` — gatilho "evidência de fingerprint/rotação do adversário" = ATINGIDO).

---

## A. Identidade (top-3, 30d — 87% das pré-liquidações)

| # | Endereço "liquidator" (contrato executor) | Share | Execs | Tipo de conta | EOAs (rotação) | Gás | Priority fee |
|---|---|---|---|---|---|---|---|
| **1** | `0x1b18c1d3445630cfe6e0744e1b2d6ab7985d06ef` | **54,9%** | 492 | Contrato ~21,5KB (NÃO verificado; criador `xiaomisafe.base.eth`, ~25d) | **44 EOAs** 🚨 | ~490k | **legacy type-0, ~1,31 gwei** |
| **2** | `0x218172c19435ba4adfe3d212f3fa9e4e329e782b` | 24,8% | 222 | Contrato ~10,3KB | 22 EOAs | ~420k | type-2, 1,24 gwei |
| **3** | `0xf1ec45222bed5472804be6e67db740b738ce5198` | 7,5% | 67 | **EIP-7702** (EOA delegado → impl `0x3428d0b36ca5857234c4e8842efb47c69af355d7`) | 12 EOAs | ~456k | **44 gwei** (overpaga, perde) |

- **Todos são contratos executores** (o "liquidator" do evento = `msg.sender` do `preLiquidate` = contrato próprio).
  EOA assina → chama o contrato → `preLiquidate` + `onPreLiquidate`. Confirmado.
- **Rotação de senders = infra séria:** #1 usa **44 EOAs**; observamos **4 pré-liquidações no MESMO bloco
  de 4 EOAs diferentes** (lanes de nonce paralelas → dispara várias simultâneas sem contenção).
- **#3 é EIP-7702** (Pectra) — turbina um EOA em smart account. Moderno, mas paga gás demais e fica em 3º.

## C. Execução (trace de tx real do #1 · `0xa529ce…99bc`, sucesso, 459k gas)

Fluxo: `preLiquidate` (entry selector `0x65ed7feb`) → recebe **cbBTC** → **1 swap cbBTC→USDC** numa pool
**UniV3/Slipstream** (single-hop, single-DEX) → `approve` USDC pro contrato PreLiquidation → **repay** no
Morpho singleton (`0xbbbb…ffcb`).
- **SEM flashloan** — usam o adiantamento do colateral pelo callback (mais barato, sem fee).
- **Single-DEX, single-hop** — não roteiam entre DEX. **Aqui temos vantagem potencial** (multi-DEX) em pares
  onde a melhor rota está espalhada — embora em par fundo (cbBTC/USDC) single-pool já seja ~ótimo.
- **Foco = mercados GRANDES** (cbBTC). → a cauda (mercados menores) é menos contestada pelo #1.

## Veredito do método (o binário que o Humberto previu)
> "Se o contrato deles for chato → o trono está na INFRA." **É o caso.** Contratos padrão; a diferença é
> **latência de monitoramento + execução paralela (44 EOAs) + foco nos mercados grandes**. Copiar contrato
> NÃO destrona. **A alavanca é infra.**

## Porta de entrada (cauda → não ficamos lá)
1. **Mercados onde o #1 (cbBTC-focado) é fino** — os ~20 mercados ativos menores (de 22). Entrar por colateral
   medium-cap/LSD/stable, nosso padrão sub-servido.
2. **Multi-DEX** como diferencial onde a rota importa (eles fazem single-pool).
3. **Sem flashloan** (igual a eles) — caminho mais barato; já temos o `_executeSwaps`.

## B1. Dinâmica de reação — MEDIDO (o achado que vira a mesa)

**A competição NÃO é corrida de latência (winner-take-all no 1º bloco). É um GRIND de presença.**
- Em 30d, só **29 posições distintas** foram pré-liquidadas, cada uma fatiada **~31× em média** (máx **160×**).
  **21 das 29 têm ≥10 fatias.** A pré-liq é parcial (`preLCF` ~10%) → a MESMA posição é fatiada dezenas de
  vezes ao longo de blocos.
- **Ninguém ganha por "chegar primeiro":** o #1 é o 1º num borrower só **1,4%** das vezes (#2: 4,5%; #3: 0%).
  Eles faturam pegando **fatia atrás de fatia**, não correndo pra ser o 1º.
- **O #1 vence por PRESENÇA + PARALELISMO:** 44 EOAs disparando toda janela (observado: 4 pré-liq no mesmo
  bloco, 4 EOAs).
- **Implicação enorme:** sair da cauda é **infra/orquestração** (monitorar posições encrencadas + disparar em
  paralelo), **NÃO guerra de microssegundos** (que perderíamos). **Terreno amigável ao nosso stack TS.**

## C2. Batch trace — 10 txs do #1 (certeza absoluta do padrão)
`10/10 sucesso · 0 reverts · 0 flashloan · 9/10 single-hop/single-DEX · todos cbBTC→USDC`
- **Nunca flashloan** (callback advance). **1 pool por tx** (UniV3 OU Aerodrome; nunca multi-rota).
- **3/10 têm 0 swaps** = modo **inventário** (pré-funda USDC, repaga, **fica com o cbBTC** — usa capital).
  O #1 mistura **callback+swap** (sem capital) e **inventário** (com capital). **0 reverts = gate preciso.**

## Wallet-pool/rotação — DECISÃO TOMADA (2026-06-26): SIM, no roteiro do pre-liq
O líder usa **44 EOAs em paralelo** e a competição é **presença/paralelismo**, não latência → com 1 sender
ficamos na cauda por construção (1 fatia/bloco). **Decidido (Humberto): wallet-pool ENTRA no roteiro do
Motor 1 pre-liquidation**, escala inicial **~22 EOAs (metade do líder)**, observar e escalar rumo a 44 se
pagar. Derivar de 1 seed (HD), hot keys só com gás (caminho feliz é flashloan-free). Entra junto/depois da
Fase 1 do contrato. Reverte a decisão de maio (ver memória `project-zeus-evm-wallet-pool-decision`).

## B/D. Foco de mercado + revert + a PORTA DE ENTRADA (MEDIDO 2026-06-26)

**12 mercados ativos (30d). O #1 só joga blue-chip; ignora o long-tail medium-cap = nossa porta.**

| Contrato (mercado) | Par (colateral/dívida) | execs | #1 | #2 | #liq | Leitura |
|---|---|---|---|---|---|---|
| 0xa7272afc | **cbBTC/USDC** | 507 | 310 (61%) | 85 | 14 | trono do #1 (blue-chip) |
| 0x9ca1dad9 | **WETH/USDC** | 125 | 8 (6%) | 97 | 10 | turf do #2 (blue-chip contestado) |
| 0x9231db26 | **cbETH/USDC** | 101 | 77 | 23 | 3 | #1 domina, só 3 liq |
| 0x742d1c11 | **WETH/EURC** | 44 | 43 (98%) | 0 | 2 | nicho do #1 |
| **0x95c3b46a** | **bsdETH/eUSD** | 13 | **0** | 2 | 3 | 🚪 **#1 AUSENTE — LSD/medium-cap** |
| **0xe0b8556b** | **cbETH/MAI** | 6 | **0** | 0 | **1** | 🚪 **#1 ausente, 1 liq — LSD** |
| **0x757624b9** | cbBTC/USDC (2º) | 4 | **0** | 0 | **1** | 🚪 #1 ignora este contrato cbBTC |
| **0xac22a696** | **cbLTC/USDC** | 2 | **0** | 0 | **1** | 🚪 **#1 ausente — medium-cap** |

→ **Porta de entrada confirmada:** **bsdETH, cbETH/MAI, cbLTC** (e o long-tail Morpho em geral) — medium-cap/LSD
onde o #1 (cbBTC-focado) **não aparece**, com **1-3 liquidadores**. É **exatamente o nosso edge sub-servido**.

**Taxa de revert (30d, txs ao executor) — o grind é guerra de spam; precisão é janela nossa:**
| | txs | landadas | **% revert** |
|---|---|---|---|
| #1 | 771 | 492 | **36%** (eficiente — simula bem antes de disparar) |
| #2 | 2.158 | 464 | **78,5%** (esbanja gás) |
| #3 | 525 | 67 | **87%** (queima gás à toa) |
- O grind custa gás: disparam N tentativas, a maioria reverte (fatia já pega). **#1 vence também por PRECISÃO.**
- **Nossa vantagem potencial:** a nossa **simulação eth_call + EV gate** (já temos) tende a revert MENOS que
  #2/#3 → mais fatia ganha por gás gasto. Edge real e barato.

## O que falta medir (resíduo — opcional)
- **D — PnL líquido USD por pré-liq por mercado** (bônus `preLIF` − gás − overhead de revert): precisa preço dos
  tokens. **Só o DRY_RUN responde de verdade** (overhead de revert agora medido = relevante).
- **Decompilar o #1 (Dedaub):** baixa prioridade — o trace já provou contrato padrão (sem flashloan/multi-DEX);
  só pra cravar 100%.
- **B1 — Latência de reação** (blocos entre cruzar `preLltv` e a tx landar): o número que define se "sair da
  cauda" é fácil (rota mais barata, copiável) ou caro (RPC/Flashblocks). **Decisivo, ainda não medido.**
- **B — Foco de mercado por competidor** (em quais dos 22 o #1 NÃO aparece = nossa porta), **close factor**
  (fatia pequena repetida vs. máxima), **taxa de revert** (gás à toa = janela), **correlação c/ volatilidade**.
- **C — priority fee fino** do #1 (legacy → derivar efetivo) + canal de inclusão (sequencer normal vs Flashblocks).
- **D — Economia:** lucro líquido por pré-liq por mercado; % do volume nos colaterais-alvo (LSD/medium-cap).
- **Decompilar** o contrato do #1 (Dedaub) já que não é verificado — confirmar que não há truque escondido.

## Para a OIE (fingerprint — alimentar `senderRegistry`/`CompetitorResolver`)
```
preliq_competitors_base:
  rank1: { executor: 0x1b18c1d3445630cfe6e0744e1b2d6ab7985d06ef, eoas: 44, type: legacy, share: 0.55, focus: cbBTC, verified: false, creator: xiaomisafe.base.eth }
  rank2: { executor: 0x218172c19435ba4adfe3d212f3fa9e4e329e782b, eoas: 22, type: eip1559, share: 0.25 }
  rank3: { executor: 0xf1ec45222bed5472804be6e67db740b738ce5198, impl: 0x3428d0b36ca5857234c4e8842efb47c69af355d7, type: eip7702, share: 0.075 }
```

## Fontes/método
- Eventos `PreLiquidate` (`0xd5b01f…`) + `CreatePreLiquidation` (`0xc36ddf…`) via Dune `base.logs`.
- `cast code` (Alchemy) p/ tipo de conta + EIP-7702. `alchemy_getAssetTransfers` p/ txs. Receipt logs p/ trace.
- Basescan (web) p/ verificação + criador. Queries Dune públicas: 7820075/76 (trono), 7820228/51 (gás/EOAs).
