# Recon competitivo — fillers UniswapX na Base (Motor 2)

> Inteligência on-chain (Dune API + cast/Base RPC), 2026-06-26, janela 14d. Mesma diligência do
> `COMPETITOR_RECON_PRELIQ.md` (Motor 1): camadas A (identidade) · B (comportamento) · C (execução) ·
> D (economia + porta de entrada). Honestidade > otimismo cego.
> Reactors: V2 `0x000000001Ec5656dcdB24D90DFa42742738De729` + V3 `0x000000008a8330B5d1F43A62Bf4C673A49f27ba0`.
> Fill topic0 `0x78ad7ec0…bd66`. Margem por par já medida em `UNISWAPX_FILLER_FEASIBILITY.md` (Passo 2).

---

## Camada A — Identidade dos top fillers

| # | Filler (contrato) | fills/14d | EOAs | dex-sourced | gás (gwei) |
|---|---|---|---|---|---|
| 1 | `0xa0e582bf…3ab8` | 108 | **1** | 90,7% | 0,005 |
| 2 | `0xb2d35561…439a` | 68 | 4 | 94,1% | 0,035 |
| 3 | `0x05898436…4d92` | 56 | 4 | 83,9% | 0,006 |
| 4 | `0x9b824dd3…c7a9` | 49 | **27** | 98,0% | 0,203 |
| 5 | `0x225a38bc…dc17` | 43 | 6 | **0%** (inventário puro) | 0,005 |
| 6 | `0xf0000000…96ba` | 21 | 21 | 100% | 0,005 |

- **Todos os top fillers são CONTRATOS próprios** (~15–20 KB de bytecode), igual ao Motor 1. Não são EOAs simples.
- **Concentração:** top-4 ≈ **46%** dos fills; ~18 fillers ativos no dex-sourced. Fragmentado (nenhum domina sozinho).
- **EOAs/sender:** varia muito — o líder usa **1 EOA** pra 108 fills (presença NÃO é a alavanca dele); o #4 usa 27.
  Diferente do Motor 1 (líder com 44 EOAs paralelos). Aqui o jogo não é spam de senders.

## Camada B — Comportamento (a grande confirmação)

- **90–100% dos top fillers são DEX-SOURCED** (buscam liquidez em DEX), NÃO inventário. Só **1 dos 6** (#5)
  é market-maker de inventário puro. **Isso DESMONTA o pior medo da §5 do feasibility:** competimos de
  igual pra igual (mesmo modelo de sourcing), não contra inventário imbatível.
- **Gás 0,005 gwei** na esmagadora maioria → Base é FCFS, **não há guerra de gás** (igual Motor 1). O edge
  não é pagar mais gorjeta.
- **Multi-hop 3–9 saltos** por fill → o jogo é **qualidade de roteamento** (achar a melhor rota multi-DEX).

## Camada C — Execução (como o líder opera)

Trace de uma fill do #1 (`0xfd780911…6933`):
- **SEM flashloan.** O reactor entrega o token de entrada no callback → o filler faz o sourcing direto e
  devolve a saída. Atômico — **exatamente o modelo do nosso `ZeusMorphoPreLiquidator`** (callback + swap).
- **Roteamento PROFUNDO:** 13 contratos tocados, 48 logs, **2,56M de gás** numa fill. Multi-pool pesado.
- Tocou USDC/WETH/cbBTC **+ o `0x498581fF…2b2b` = Uniswap V4 PoolManager (CONFIRMADO on-chain:**
  responde `owner()` = Uniswap governance). ⚠️ **Hoje NÃO cobrimos V4** — os líderes acessam liquidez V4
  que o nosso roteador (UniV3/Aerodrome/Slipstream/UniV2/Pancake) não enxerga. **Gap de rota REAL.**

## Camada D — Economia + porta de entrada

- **Margem (medida, Passo 2):** long-tail **20–120 bps** median vs **~5 bps** blue-chip. Cobre o gás da
  Base (centavos) com folga. **A economia por-fill fecha.**
- **Especialização:** os top-4 são **GENERALISTAS** — blue-chip pesado (WETH/USDC/ETH) **E** long-tail
  (VIRTUAL, VVV, NOCK, AERO, rETH, wstETH, cbBTC). **Diferença CRÍTICA vs Motor 1:** lá o líder IGNORAVA o
  long-tail (porta limpa); **aqui o long-tail é DISPUTADO pelos mesmos líderes.** Não há nicho órfão óbvio.

---

## Síntese — onde dá pra ganhar (e onde dói)

| Sinal | Motor 1 (pré-liq) | Motor 2 (filler UniswapX) |
|---|---|---|
| Competição = dex-sourced (batível)? | ✅ sim | ✅ **sim** (90–100%) |
| Gás é a guerra? | ❌ não (presença) | ❌ **não** (FCFS, 0,005 gwei) |
| Modelo (sem flashloan, atômico) | ✅ nosso | ✅ **idêntico** (callback) |
| Margem cobre gás? | ✅ | ✅ (20–120 bps long-tail) |
| **Porta de entrada** | ✅ **nicho ignorado** pelo líder | ⚠️ **long-tail DISPUTADO** pelos líderes |
| Alavanca | presença (wallet-pool) | **qualidade de roteamento** (multi-DEX **+ V4**) |
| Gap nosso a fechar | — | **cobertura Uniswap V4** + app de fill |

**Conclusão honesta:** o filler é **batível e a economia fecha**, mas é **mais disputado que o pré-liq** — não
tem nicho órfão, e os líderes têm uma vantagem de rota (**V4**) que precisamos igualar. O edge aqui **não é
presença** (1 EOA basta), é **roteamento melhor**: ganhar a fill quando a nossa rota multi-DEX bate a deles.
Pra "estar pronto pra faturar" (regra do Humberto), o build precisa fechar o gap de V4 — senão entramos
como filler de 2ª linha, perdendo as rotas que passam por V4.

---

## Plano de build (pra deixar o Motor 2 pronto pra faturar)

Reaproveita ~60–70% (quoting multi-DEX, simulação, executor atômico, gas oracle, relays). Falta:

- **F1 — Cobertura Uniswap V4 (gap do recon):** adapter de quote + rota V4 no `dex-adapters` +
  execução V4 no executor. **É o diferencial que os líderes usam.** Esforço médio-alto (V4 é singleton
  PoolManager + hooks — modelo novo). _Pré-requisito pra competir nas rotas boas._
- **F2 — Contrato `IReactorCallback`** no `ZeusArbExecutor` (reusa `_executeSwaps`; folga EIP-170 ~8KB) +
  fork test + **redeploy testnet**. Mesmo padrão do callback de pré-liq.
- **F3 — App filler** (`apps/uniswapx-filler` ou módulo no mis-scanner): ingestão de ordens (polling
  6 rps) + ordem→rota (reusa `buildSwapSteps` + V4) + `simulateArbitrage` + EV gate + dispatch.
  **Execução OFF por default** (armado-mas-travado, igual Motor 2 atual + KILL_SWITCH).
- **F4 — DRY_RUN:** simular quais ordens preencheríamos com lucro (sem enviar), medir win-rate real
  contra os 18 fillers. Calibrar antes de ligar.
- **F5 — Ligar:** testnet/fork → capital pequeno, só com win-rate provado no DRY_RUN.

**Ordem sugerida:** `0x498581ff…` = V4 **CONFIRMADO** → F2+F3 primeiro com cobertura atual
(entra ganhando as rotas não-V4, valida o pipeline) → F1 (V4) pra subir o win-rate. Assim faturamos
cedo no subconjunto que já dominamos e expandimos pro resto.

> **Ressalva honesta:** sem nicho órfão, o win-rate inicial será uma FRAÇÃO (somos o 19º filler). A
> economia fecha por-fill, mas o volume capturado depende de roteamento ≥ líderes. É um build real,
> não um atalho — mas é viável e a regra é deixá-lo pronto pra faturar.
