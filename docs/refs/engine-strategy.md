# Estratégia dos 3 motores — ZEUS EVM

> Decisão de estratégia de receita (2026-06-15). Como combinar os motores pra ter
> lucro ao longo do tempo, dado o stack (TS+viem) e a chain (Base).
> Ver: [`morpho-profit-projection.md`](./morpho-profit-projection.md) · [`competitive-landscape.md`](./competitive-landscape.md) · [`infra-costs.md`](./infra-costs.md).

---

## A verdade central

**Nenhum motor sozinho dá "salário mensal fixo".** O motor mais forte (liquidações) é o mais
irregular — fatura em crash, ~zero em mês lateral. A consistência **não vem de um motor, vem da
combinação descorrelacionada** (tese original do CLAUDE.md: #1 crash, #2 volume, #3 volatilidade).

---

## Mapa dos motores

| Motor | Ritmo de receita | Competitividade (TS+Base) | Papel |
|---|---|---|---|
| **Liquidações (Morpho)** | 🔴 Lumpy (crash do BTC) | 🟢 Boa — TS aguenta, edge intacto (sem OEV no cbBTC/USDC) | **Núcleo de alto valor** (irregular) |
| **Cross-DEX / triangular arb (medium-cap)** | 🟢 Contínuo (todo bloco tem spread) | 🟡 Fraca em mainstream; fresta na long-tail | **Baseline mensal** (pequeno) |
| **Backrun** | 🟡 Semi-contínuo | 🔴 Desvantagem estrutural (latência) | Adiar (Sprint 4/5) |

---

## A estratégia

1. **Núcleo = Liquidações Morpho.** Maior EV por evento, TS-viável, edge intacto. **Renda anual ÷ 12**, não mensal. Paga muito em ano volátil, pouco em ano calmo.
2. **Baseline = Cross-DEX medium-cap arb.** Oportunidade acontece todo bloco → renda menor e mais constante. **Vale mesmo pequeno**, sob UMA condição (abaixo).
3. **Backrun = depois.** Não compensa em TS agora.

### Por que o baseline pequeno vale a pena
- **Paga a infra** (~$250-350/mês) → liquidação vira lucro limpo no crash.
- **Mantém o bot quente e aprendendo** → alimenta o ledger/OIE, calibra os scores.
- **Suaviza caixa e psicológico** → renda constante > meses de zero.
- **Valida a infra** pro dia do crash (quando não pode falhar).

### A condição inegociável
> **Pequeno POSITIVO ≠ pequeno negativo.** Roda o arb **só enquanto net-positive após gas**
> (mesmo $5/dia vale). Se virar net-negativo (gas em corridas perdidas) → desliga.
> O **EV gate (Etapa B)** já protege: descarta a oportunidade antes de gastar gas quando o EV
> não compensa. O **DRY_RUN** diz, sem arriscar capital, se o "pequeno" é positivo.

---

## Plano de execução

1. **Agora:** provar o motor #1 (Morpho) no DRY_RUN — medir se o ZEUS "teria chegado primeiro" vs. quem liquidou de fato (`senderRegistry` + ledger).
2. **Em paralelo (custo zero):** detector (arb) rodando passivo → medir se há baseline contínuo capturável em medium-caps.
3. **Decidir com dado:** arb net-positive → vira baseline mensal. Net-negativo → liquidação é renda lumpy mesmo, dimensionar expectativa pra isso.
4. **Backrun/JIT:** só nos Sprints 4/5, com infra de mempool premium.

---

## Resumo

- **Lucro "mensal/contínuo"** → cross-DEX arb (pequeno, mas só se DRY_RUN provar captura positiva).
- **Lucro "de verdade"** → liquidação Morpho (grande, mas lumpy).
- **Estratégia vencedora** → rodar os dois; um cobre o outro. Pequeno positivo é bem-vindo —
  paga a casa e mantém o bot vivo entre os crashes.
