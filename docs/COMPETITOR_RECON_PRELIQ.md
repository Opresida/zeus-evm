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

## O que falta medir (próxima camada — B/C/D em profundidade)
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
