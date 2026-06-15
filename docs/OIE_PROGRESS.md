# OIE — Status de adoção (Opportunity Intelligence Engine)

> Documento vivo. Onde estamos na adoção do **OIE Master Blueprint** + decisões tomadas.
> Branch de trabalho: `claude/bot-performance-analysis-55qp9o` → PR #1 → `main`.
> Última atualização: 2026-06-15.

---

## Mapa do plano (Etapas A→D)

| Etapa | Escopo | Status |
|---|---|---|
| **A** | Scores Opportunity/Protocol/Pool/Token + ledger DuckDB | ✅ Feito |
| **B** | Ligar os scores nos motores que dispatcham | 🟡 Parcial |
| └ Backrun | EV gate competitor-aware (via gas war) | ✅ Feito |
| └ Liquidator | EV gate **ciente de OEV** (prioriza Morpho) | ✅ Feito |
| └ Detector | ranking na descoberta (radar passivo) | 🔲 Falta (baixa prioridade) |
| **DRY_RUN** | Detector + MIS gravam no ledger DuckDB; infra Fly.io persistente | ✅ Feito |
| **C** | Auto-prioritization + thresholds adaptativos (loop de feedback) | 🔲 Falta |
| **D** | 8 dashboards Grafana | 🔲 Falta |

### DRY_RUN intelligence (2026-06-15)
- **Detector** (`apps/detector`) e **MIS scanner** (`apps/mis-scanner`) agora gravam oportunidades
  observadas no ledger DuckDB (categorias `arb_observed` / `mis_observed`) — antes só logavam.
- `execution-utils`: `buildObservationEvent`, `resolveIntelligenceDbPath` (honra
  `INTELLIGENCE_DB_PATH`), `queryTopOpportunityPairs` + `attachAndRankPairs` (ranking de pares,
  unificação cross-motor via ATTACH — DuckDB é single-writer).
- Liquidator/backrun passam a honrar `INTELLIGENCE_DB_PATH` (volume persistente).
- Deploy Fly.io: `Dockerfile` + `deploy/fly/*.toml` (volume persistente obrigatório).
  Guia: [`refs/fly-deploy.md`](./refs/fly-deploy.md).
- ✅ **Detector ligado na varredura dinâmica** (`getTargetPairsForChain`): consome curados +
  auto-targets do `discovery-scraper`. Sem arquivo auto-targets, cai nos curados (idêntico ao
  anterior). Rodar o scraper amplia a cobertura do detector sem mexer em código.

---

## O que já está no código (commits desta branch)

### Etapa A — camada de scoring (puro + DuckDB)
`packages/execution-utils/src/scoring/`
- `opportunityScorer.ts` — Opportunity Score universal: `evUsd` (P(sucesso) × lucro líquido) + score composto [0,1].
- `dimensionScorer.ts` — Protocol/Pool/Token Score (fórmulas do blueprint), puro.
- `dimensionStatsQuery.ts` — agrega o histórico do DuckDB (`events`) em `DimensionStats`.
- Fix: `timeseriesStore` gravava `timestamp` (Unix ms) como INT32 e estourava → agora BIGINT.

### Etapa B — backrun
`apps/backrun-engine/src/pipeline.ts` + `scoreBackrunOpportunity`
- EV competitor-aware via nível de **gas war** (priors `GAS_WAR_PRIORS`).
- Gate **opt-in** `MIN_OPPORTUNITY_EV_USD` (default desligado).
- Score emitido no evento `backrun.opportunity_found` → ledger DuckDB.

### Etapa B — liquidator (com prioridade Morpho via OEV)
`apps/liquidator/src/pipeline.ts` + `scoreLiquidationOpportunity`
- Helper aplica **"OEV haircut"** por protocolo: lucro realista = nominal × (1 − recapture).
- Plugado nos **4 runners** (Aave/Compound/Morpho/Moonwell) logo após o `decision`.
- **SEMPRE loga** o score pós-OEV (observabilidade — você vê quais protocolos viraram antieconômicos mesmo com o gate desligado).
- Gate **opt-in** `MIN_OPPORTUNITY_EV_USD`: quando setado, descarta liquidações cujo EV pós-OEV < mínimo → o bot **foca em Morpho** naturalmente.

---

## ⚠️ Decisão central: priorizar Morpho (achado de pesquisa)

A pesquisa de mercado (ver [`docs/refs/competitive-landscape.md`](./refs/competitive-landscape.md))
mostrou que **liquidação na Base está se fechando por OEV capture**:

| Protocolo | OEV recapture (Base) | Edge pro liquidador externo |
|---|---|---|
| **Morpho Blue** | **0%** (aberto) | ✅ **Edge real** — foco do bot |
| Aave V3 (ativos principais) | ~85% (Chainlink SVR) | ⚠️ Quase nulo |
| Compound III | ~85% (SVR/Atlas) | ⚠️ Quase nulo |
| Moonwell | ~99% (MEV tax on-chain) | ❌ Praticamente nulo |

Esses valores estão codificados em `OEV_RECAPTURE_PRIORS` (execution-utils) como **defaults
calibráveis**. Forks de Aave (ex.: Seamless) são tratados como abertos (recapture 0), pois não
têm SVR por padrão.

---

## Como LIGAR o gate (quando você quiser)

Por padrão está **desligado** — o comportamento atual não muda, só passa a logar o score.

Pra ativar a priorização (descartar liquidações antieconômicas pós-OEV):
```bash
# .env do liquidator e/ou backrun
MIN_OPPORTUNITY_EV_USD=2     # ex.: só executa se o EV realista pós-OEV ≥ $2
```
Com isso, Aave/Compound/Moonwell na Base tendem a cair no gate (recapture alto) e o bot foca em
Morpho. Comece observando os logs (`🧮 OIE liquidation score`) em DRY_RUN antes de ligar o gate.

---

## Pontos de calibração (pós-DRY_RUN, com dado real)

- `OEV_RECAPTURE_PRIORS` — frações de recapture por protocolo (hoje: defaults da pesquisa).
- `GAS_WAR_PRIORS` — competição/successProbability por nível de gas war (backrun).
- `OPPORTUNITY_NORMALIZE` — saturação de lucro ($50) e slippage (100 bps).
- `DIMENSION_NORMALIZE` — saturação por dimensão (density, liquidez, competição).
- `successProbability` default da liquidação = 0.7 (ajustar com win-rate real).

---

## Verificação (estado atual)

- `pnpm typecheck` — **13/13 workspaces** verdes.
- `pnpm --filter @zeus-evm/execution-utils test` — **288/289** (a única falha,
  `failureCollector.test.ts`, é **pré-existente** e sem relação com este trabalho; confirmado
  via `git stash`).
- Novos testes: `opportunityScorer.test.ts` (15), `dimensionScorer.test.ts` (10),
  `dimensionStatsQuery.test.ts` (8).

---

## Próximos passos sugeridos

1. **Repriorizar a descoberta do liquidator pra Morpho na Base** (além do gate): hoje o gate
   descarta no pós-cálculo; idealmente o discovery já daria menos esforço a Aave/Compound/Moonwell.
2. **Etapa B — detector** (baixa prioridade; é radar passivo).
3. **Etapa C** — loop adaptativo: recalcular thresholds por dimensão a partir de
   `pnlReconciler`/`failureCollector` (sem editar `.env`).
4. **Etapa D** — dashboards Grafana (o `prometheusExporter` já existe).
5. **Confirmar mercado a mercado** se Aave V3/Compound III na Base já estão 100% sob SVR — se
   algum ativo long-tail ainda estiver aberto, é edge residual.
