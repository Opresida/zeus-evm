# Custos de infraestrutura — ZEUS EVM (Base L2)

> Estimativa de custo mensal (USD) pra rodar o ZEUS, com links de compra.
> Pesquisa: 2026-06-15. Preços mudam — confirmar nos links antes de assinar.
> Contexto da recomendação: foco em **liquidações Morpho Blue na Base** (ver
> [`competitive-landscape.md`](./competitive-landscape.md) e [`../OIE_PROGRESS.md`](../OIE_PROGRESS.md)).

---

## ⚠️ Distinção importante: RPC ≠ Node próprio

| Conceito | O que é | ZEUS precisa? |
|---|---|---|
| **RPC** (Alchemy/dRPC/QuickNode...) | Assinatura de acesso a um node que OUTRO roda. Você só consome a API. | ✅ **Sim, sempre** — já usa (dRPC + Alchemy). |
| **Node próprio** | VOCÊ roda um servidor op-geth/op-node da Base (full/archive). | ❌ **Não** — caro e desnecessário pra liquidação. |

**Subir o plano do RPC ≠ montar node próprio.** A linha "RPC baixa latência" abaixo é só um
**plano melhor do mesmo serviço** que já usamos, não um servidor novo.

---

## 💵 Cenário A — AGORA (DRY_RUN / validação) → ~$15–65/mês

| Item | Serviço | USD/mês | Link |
|---|---|---|---|
| RPC | dRPC Free **ou** Alchemy Free (→ QuickNode Build $49 se quiser confiabilidade) | $0–49 | [dRPC](https://drpc.org/pricing) · [Alchemy](https://www.alchemy.com/pricing) · [QuickNode](https://www.quicknode.com/pricing) |
| VM (hosting) | Fly.io shared-cpu-1x (1–2 GB), Node 24/7 | $5–15 | [Fly.io pricing](https://fly.io/docs/about/pricing/) · [calculadora](https://fly.io/calculator) |
| Monitoring | Tenderly Free + Discord | $0 | [Tenderly](https://tenderly.co/pricing) |
| **Total** | | **~$15–65** | |

---

## 💵 Cenário B — Mainnet Morpho sério (capital pequeno) → ~$220–350/mês

O edge é "chegar primeiro" → o dólar mais importante é **RPC de baixa latência**.

| Item | Serviço | USD/mês | Link |
|---|---|---|---|
| **RPC baixa latência** (o edge) | Chainstack Pro $199 **ou** QuickNode Scale $299 **ou** dRPC PAYG (~$6/1M req) | $199–299 | [Chainstack](https://chainstack.com/pricing/) · [QuickNode](https://www.quicknode.com/pricing) · [dRPC](https://drpc.org/pricing) |
| VM | Fly.io performance-1x / shared-cpu-2x (CPU pra scan agressivo de HF) | $15–82 | [Fly.io](https://fly.io/docs/about/pricing/) |
| Monitoring | Tenderly Free (ou Starter $45 se precisar de mais TU) | $0–45 | [Tenderly](https://tenderly.co/pricing) |
| **Total** | | **~$220–350** | |

---

## ❌ NÃO comprar agora (segura o dinheiro)

| Item | Custo | Quando faz sentido | Link |
|---|---|---|---|
| **bloXroute** (mempool premium) | $300–1.250/mês (Professional $300 / Enterprise $1.250; modelo a-la-carte mar/2026 → contact sales pra Base) | Só no **Sprint 4/5** (backrun/JIT) | [bloXroute pricing](https://bloxroute.com/pricing/) |
| **Node Base próprio** (archive) | $250–500/mês + ops (disco cresce ~500 GB/semana; archive ~2–4 TB, 128 GB RAM) | Só se RPC gerenciado provar latência insuficiente (improvável p/ liquidação) | [Base node docs](https://docs.base.org/) · [Hetzner SX](https://www.hetzner.com/dedicated-rootserver/matrix-sx/) |
| **Rewrite Rust** | tempo, não $ | Só se for sério em backrun (latência pura) | — |

---

## Tabela de referência — tiers de RPC (preços pesquisados jun/2026)

| Provider | Tier | USD/mês | Quota |
|---|---|---|---|
| **Alchemy** | Free | $0 | 30M CU/mês |
| Alchemy | Pay-as-you-go | usage | ~$0.40–0.45/M CU (Growth/Scale descontinuados fev/2025) |
| **QuickNode** | Free | $0 | 50M credits |
| QuickNode | Build | $49 | 80M credits |
| QuickNode | Scale | $299 | ~3B credits |
| QuickNode | Business | $899–999 | ~2B credits |
| **dRPC** | Free | $0 | 210M CU/30d |
| dRPC | Pay-as-you-go | depósito | 20 CU/req · ~$6/1M requests (jun/2025) |
| **Chainstack** | Developer | $0 | 3M req (~25 RPS) |
| Chainstack | Growth | $49 | 20M req (~250 RPS) |
| Chainstack | Pro | $199 | 80M req (~400 RPS) |
| Chainstack | Business | $349 | 140M req (~600 RPS) |
| **Tenderly** | Free / Starter / Pro | $0 / $45 / $450 | 35M / 350M TU |

> Limites: páginas da Fly.io e Tenderly bloquearam fetch direto (403) — números de fontes
> secundárias; confirmar `performance-2x` na calculadora oficial Fly. QuickNode Business diverge
> ($899 vs $999) entre fontes. bloXroute/dedicated têm tiers "contact sales" sem preço público p/ Base.

---

## Resumo

- **Hoje:** ~**$50/mês** cobre o DRY_RUN confortável.
- **Mainnet Morpho:** ~**$250–350/mês**, com o grosso indo pra **RPC de baixa latência** (não mempool, não node próprio).
- O gasto do Cenário B só se justifica **depois** do DRY_RUN provar que o Zeus chega primeiro no Morpho.
