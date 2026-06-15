# Projeção de lucro — Liquidações Morpho Blue na Base (ZEUS motor #1)

> Pesquisa: 2026-06-15. Projeção baseada em dados de mercado (fontes no fim).
> ⚠️ Liquidação é receita **lumpy** (concentrada em crashes), NÃO mensal estável.
> Ver também: [`competitive-landscape.md`](./competitive-landscape.md) · [`infra-costs.md`](./infra-costs.md).

---

## 🟢 Status do edge (verificação OEV — 2026-06-15)

**O mercado cbBTC/USDC da Coinbase no Morpho Base entrega o bônus de ~4,9% INTEIRO ao
liquidador externo.** NÃO há captura de OEV via Oval (UMA) nem Chainlink SVR nesse mercado:

- Morpho Blue **não cobra fee de liquidação** — bônus inteiro é incentivo do liquidador (design).
- OEV capture no Morpho é **opt-in por mercado**; Oval ficou restrito a poucos mercados em
  **Ethereum** (mai/2024) e foi superado pelo SVR. **Nenhuma evidência de Oval/SVR na Base.**
- cbBTC/USDC Coinbase usa **feed Chainlink puro**, sem wrapper de recaptura.
- SVR está chegando na Base, mas na **Aave** (não Morpho) — confirmado para Aave cbBTC, não Morpho.

**Ressalvas:**
1. Confiança alta, mas **não confirmado on-chain** (app.morpho.org bloqueia leitura). Confirmar o
   `oracle` da market `0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836` (Base).
2. **Risco de migração:** SteakHouse/Coinbase revisam oráculos; se adotarem SVR, o edge cai de
   ~4,9% pra fração. **Monitorar o oráculo on-chain periodicamente.**

---

## Dados de mercado (Morpho Base)

| Métrica | Valor |
|---|---|
| Empréstimos ativos na Base | ~**$1,18B** (2ª maior rede do Morpho) |
| Mercado dominante | **cbBTC/USDC** (Coinbase), LLTV 86% |
| Colateral cbBTC no Morpho | >$1,4B |
| **Bônus do liquidador** (LIF−1 @ LLTV 86%) | **~4,9%** |
| Fórmula LIF | `min(1.15, 1/(0.3·LLTV + 0.7))` (whitepaper) |
| Frequência | **Lumpy** — eventos em crashes de BTC, ~zero em meses laterais |
| Referência de crash | BTC −17% (jan-fev/2026) → ~$238M de liquidações no setor numa semana |

> Tabela LIF por LLTV: 38-62% → 15% (cap) · 77% → ~8,6% · **86% → ~4,9%** · 91,5% → ~3,1%.
> O mercado principal da Base (86%) paga só ~4,9% — margem boa só em **posições grandes**.

---

## A fórmula (transparente)

```
Lucro ≈ volume_liquidado × %captura × bônus(4,9%) × ~80% líquido
```
- **~80% líquido** = pós gas (Base é barato) + slippage na venda do cbBTC; flashloan ~0% (Morpho/Balancer fallback).
- **%captura** = fração do volume total que o ZEUS ganha (winner-takes-all por posição; muitos bots competindo).

---

## Cenários (5% de captura, como pedido)

O **grande desconhecido é o volume anual de liquidação no Morpho Base** — sem número público limpo
(ver Dune `changhao/morpho-liquidation-base`). 3 cenários:

| Cenário (volume liq./ano) | 5% capturado | × 4,9% bônus | Líquido/ano | **Média/mês** |
|---|---|---|---|---|
| Calmo (~$150M) | $7,5M | $367k | ~$294k | **~$24k** |
| Médio (~$350M) | $17,5M | $857k | ~$686k | **~$57k** |
| Volátil (~$700M) | $35M | $1,72M | ~$1,37M | **~$114k** |

**Escala linear:** se a captura real for 1% (não 5%), divida tudo por 5 → **~$5k–23k/mês**.

---

## ⚠️ As 4 ressalvas que seguram esses números

1. **Os 5% são o pulo do gato NÃO COMPROVADO.** Capturar 5% do volume contra bots Rust prontos
   (o próprio Morpho tem liquidator open-source), com stack TS, é **o que o DRY_RUN tem que provar**.
2. **É lumpy, não mensal.** ~$0 em meses laterais; picos em crashes. Sem renda fixa.
3. **Bônus de só 4,9%** no mercado principal → lucro real está em **posições grandes** (Coinbase tem
   posições de até $5M), onde a competição é mais feroz.
4. **Risco de oráculo migrar pra SVR** (ver topo) → edge cairia. Monitorar.

---

## Bottom line

Com 5% de captura, a matemática dá **~$24k–114k/mês de média** — número que justifica MUITO a infra
(~$250-350/mês). O edge está intacto hoje (sem OEV capture no cbBTC/USDC Morpho Base). Mas tudo
depende de 3 "se": **se** captura 5% (não provado), **se** o oráculo não migra pra SVR, e **se** o
ano tem volatilidade. O DRY_RUN no Morpho é o teste que decide se isso vira realidade.

---

## Ações antes de capital

1. **Confirmar on-chain** o oráculo da market cbBTC/USDC Base (sem wrapper Oval/SVR).
2. **Pegar o volume real** de liquidação Morpho Base no Dune (`changhao/morpho-liquidation-base`) →
   trocar os cenários por números reais.
3. **DRY_RUN no Morpho:** medir se o ZEUS "teria chegado primeiro" vs. quem liquidou de fato
   (o `senderRegistry` + ledger já dão isso). É o sinal de que os 5% (ou qualquer %) são reais.

---

## Fontes

- [Morpho — DefiLlama](https://defillama.com/protocol/morpho-blue) · [Morpho cruza $1B na Base — CryptoTimes](https://www.cryptotimes.io/2026/01/13/morpho-crosses-1-billion-in-active-loans-on-base-network/)
- [Liquidation — Morpho Docs](https://docs.morpho.org/learn/concepts/liquidation/) · [Morpho Blue Whitepaper (LIF)](https://resources.cryptocompare.com/asset-management/17952/1732199021661.pdf)
- [$238M Liquidations — Steakhouse](https://kitchen.steakhouse.financial/p/238m-liquidations-of-onchain-lending) · [Coinbase >$1B loans via Morpho — The Block](https://www.theblock.co/post/373032/coinbase-tops-1-billion-in-bitcoin-backed-onchain-loans-via-morpho)
- [cbBTC/USDC market Base — app.morpho.org](https://app.morpho.org/base/market/0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836/cbbtc-usdc)
- [Morpho x Oval](https://app.morpho.org/ecosystem/oval) · [Oval on Morpho Update — forum](https://forum.morpho.org/t/oval-on-morpho-update/727) · [Improving Oracles — Steakhouse/forum](https://forum.morpho.org/t/improving-oracles-on-eligible-markets/2250)
- [Chainlink SVR](https://blog.chain.link/chainlink-smart-value-recapture-svr/) · [Aave SVR multi-network (Base) — gov](https://governance.aave.com/t/arfc-aave-chainlink-svr-multi-network-expansion-base-arbitrum/24241)
- Dashboards Dune: `dune.com/changhao/morpho-liquidation-base` · `dune.com/morpho/coinbase-on-chain-loan-positions-liquidations-dashboard` · app oficial: `liquidation.morpho.org`
