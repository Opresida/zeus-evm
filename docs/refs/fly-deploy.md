# Deploy Fly.io — DRY_RUN observação 24/7 + ledger persistente

> Como subir os motores de observação (detector, MIS, liquidator) na Fly.io pra acumular
> dados do mundo real, e como consultar "quais pares têm o melhor edge".
> Configs em `deploy/fly/*.toml` + `Dockerfile` na raiz.

---

## 🧠 Entenda o desenho do ledger (importante)

**DuckDB é single-writer:** um processo por arquivo. E **volume da Fly.io monta em 1 máquina por vez.**
Logo, "um arquivo compartilhado entre apps" **não funciona**. O desenho correto:

- **Cada motor escreve no SEU arquivo** `.duckdb`, no SEU volume persistente.
  - detector → `intelligence-detector.duckdb`
  - mis-scanner → `intelligence-mis.duckdb`
  - liquidator → `intelligence.duckdb`
  - backrun → `intelligence.duckdb`
- **A unificação cross-motor acontece na CONSULTA** — DuckDB faz `ATTACH` de vários arquivos e
  `UNION` (helper `attachAndRankPairs`). Ver seção "Consultar melhores pares".

**🔴 Regra inegociável:** sem **volume persistente**, a Fly.io zera o disco a cada restart/redeploy
e você **perde todo o histórico** (e a persistência é o sinal-chave do edge). Cada `fly.toml` aqui
já monta um volume em `/data` e aponta `INTELLIGENCE_DB_PATH` (e `MIS_SNAPSHOT_DIR`) pra lá.

---

## Pré-requisitos

```bash
# 1. CLI da Fly + login (ação sua — precisa da sua conta)
curl -L https://fly.io/install.sh | sh
fly auth login
```

---

## Deploy passo-a-passo (por motor)

Cada motor é um app independente. Repita o padrão. Exemplo com o **detector**:

```bash
# 1. Cria o app (1ª vez) — não faz deploy ainda
fly apps create zeus-detector

# 2. Cria o VOLUME persistente (CRÍTICO — guarda o ledger)
fly volumes create zeus_detector_data --size 1 --region iad -c deploy/fly/detector.toml

# 3. Seta o RPC da Base MAINNET como secret (observação read-only)
fly secrets set BASE_RPC_HTTP="https://<seu-rpc-base-mainnet>" -c deploy/fly/detector.toml
# opcional: fly secrets set BASE_RPC_WS="wss://..." -c deploy/fly/detector.toml

# 4. Deploy
fly deploy -c deploy/fly/detector.toml
```

**MIS scanner** e **liquidator** — mesmo fluxo, trocando o `-c`:
```bash
# MIS
fly apps create zeus-mis-scanner
fly volumes create zeus_mis_data --size 1 --region iad -c deploy/fly/mis-scanner.toml
fly secrets set BASE_RPC_HTTP="..." -c deploy/fly/mis-scanner.toml
fly deploy -c deploy/fly/mis-scanner.toml

# Liquidator (dryrun)
fly apps create zeus-liquidator
fly volumes create zeus_liquidator_data --size 1 --region iad -c deploy/fly/liquidator.toml
fly secrets set BASE_RPC_HTTP="..." -c deploy/fly/liquidator.toml
fly deploy -c deploy/fly/liquidator.toml
```

> **Smoke-test local antes** (recomendado): `BASE_RPC_HTTP=... pnpm --filter @zeus-evm/mis-scanner start`
> roda uns minutos e confirma que funciona, antes de gastar deploy.

Custos: ver [`infra-costs.md`](./infra-costs.md). Cada worker `shared-cpu-1x`/1GB + volume 1GB é
barato (~poucos $/mês cada). RPC mainnet read-only é o item principal.

---

## 📊 Consultar os "melhores pares" (o objetivo)

Depois de uns dias acumulando, você responde **empiricamente** quais pares pagam.

### Opção A — DuckDB CLI direto no volume (turnkey)
```sql
-- ranking de UM motor (ex.: detector)
SELECT pair,
       COUNT(*)                       AS observacoes,
       ROUND(AVG(profit_usd), 2)      AS lucro_medio,
       ROUND(SUM(profit_usd), 2)      AS lucro_total,
       COUNT(DISTINCT hour_utc)       AS horas_ativas   -- proxy de PERSISTÊNCIA
FROM events
WHERE category IN ('arb_observed','mis_observed','opportunity_found')
  AND pair IS NOT NULL
GROUP BY pair
ORDER BY observacoes DESC;
```

### Opção B — unificado cross-motor (ATTACH)
```sql
ATTACH 'intelligence-mis.duckdb'      AS mis      (READ_ONLY);
ATTACH 'intelligence.duckdb'          AS liq      (READ_ONLY);
WITH unified AS (
  SELECT pair, protocol, profit_usd, hour_utc, category FROM events            -- detector (main)
  UNION ALL SELECT pair, protocol, profit_usd, hour_utc, category FROM mis.events
  UNION ALL SELECT pair, protocol, profit_usd, hour_utc, category FROM liq.events
)
SELECT pair, protocol, COUNT(*) obs, ROUND(AVG(profit_usd),2) avg_usd, COUNT(DISTINCT hour_utc) persist
FROM unified
WHERE category IN ('arb_observed','mis_observed','opportunity_found') AND pair IS NOT NULL
GROUP BY pair, protocol
ORDER BY obs DESC;
```

### Opção C — via código (reusável p/ dashboards)
```ts
import { TimeseriesStore, queryTopOpportunityPairs, attachAndRankPairs } from '@zeus-evm/execution-utils';

const store = new TimeseriesStore({ dbPath: 'intelligence-detector.duckdb' });
await store.init();
const top = await queryTopOpportunityPairs(store, { chain: 'Base' });             // 1 motor
const unified = await attachAndRankPairs(store, ['intelligence-mis.duckdb'], {}); // cross-motor
```

**Como ler:** `horas_ativas`/`persist` alto = ineficiência que **persiste** (edge real, não ruído).
Lucro médio alto + persistência alta = o par pra priorizar. Isso responde o blocker #1.

---

## ⚠️ Limites honestos

1. **Observação ≠ captura.** O ledger mostra onde a oportunidade APARECE; "ganharíamos a corrida"
   só se prova com execução + dado de competidor. Persistência é o melhor proxy.
2. **Logs auxiliares** (pnl-reconciliations, failures) do liquidator ainda gravam em `logs/` local —
   pra DRY_RUN de descoberta de pares, o que importa é o ledger (`/data`), que está persistido.
3. **Backrun** precisa de mempool premium pra ser útil — adiar pro Sprint 4/5 (não incluído aqui).
4. **Unificação real-time** num só DB não dá com DuckDB (single-writer) — é por arquivo + ATTACH na
   consulta. Se um dia quiser um cérebro único online, migrar pra DB networked (Postgres/Turso).
