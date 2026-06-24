# Revisão do Schema Supabase × Frontend (cobertura de eventos)

> Comparação pedida pelo Humberto: o schema do Supabase está de acordo com o que o Frontend e os
> eventos novos do bot precisam? **Resultado: compatível, com UMA migração** (tabela `service_status`
> pro heartbeat). Este doc explica o porquê e como aplicar.

## TL;DR
| Necessidade | Schema atual | Ação |
|---|---|---|
| Eventos novos do Motor 2 (`tx.confirmed`/`tx.reverted_on_chain` com `protocol='arb'`) | `events.payload jsonb` é catch-all + colunas já cobrem; views PnL filtram só por `type` (agnósticas a protocolo) | ✅ **nada** — entra sozinho |
| Campo `pair` nos tx-events do arb | coluna `pair` já existe; ingest já mapeia `e.pair` | ✅ nada |
| Heartbeat (`zeus.heartbeat`, ~30s × 3 serviços) | iria pra `events` → **inundaria** a tabela + o realtime, afogando as transações | 🟡 **migração**: tabela `service_status` (upsert 1 linha/serviço) |
| Estado REAL do toggle (Motor 2) | `auto_paused` vem no heartbeat → `service_status` | ✅ coberto pela migração |
| `wallet_snapshots` | **não existe** no schema (era só sugestão do prompt) | ✅ sem órfã |

## Por que `events` absorve os tx-events do arb sem migração
- `public.events.payload jsonb` guarda o evento inteiro → qualquer `type`/campo novo cabe.
- As colunas usadas pela UI (`net_profit_usd`, `gas_usd`, `pair`, `tx_hash`, `protocol`…) já existem; o
  `/api/ingest` (`toRow`) já as preenche.
- As views `pnl_daily` / `pnl_weekly` filtram `type in ('tx.confirmed','tx.reverted_on_chain')` **sem olhar
  o protocolo** → quando o arb emite `tx.confirmed`, ele entra no PnL automaticamente. `pnl_by_protocol`
  agrupa por `protocol` → o arb aparece como sua própria linha (`arb`).

## A migração: tabela `service_status` (heartbeat)
**Motivo:** heartbeat é um *snapshot* periódico (não um delta). A ~30s × 3 serviços daria milhares de
linhas/dia em `events`, e o realtime empurraria as transações reais pra fora da janela que o painel busca.
Solução: tabela própria com **UPSERT por serviço** (sempre 1 linha por serviço, sobrescrita).

Fluxo: bot emite `zeus.heartbeat` → `/api/ingest` **roteia** pra `service_status` (não pra `events`) →
o painel lê/escuta `service_status` (separado de `events`).

### SQL (já incluído em `frontend/supabase/schema.sql` — rodar no SQL Editor)
```sql
create table if not exists public.service_status (
  service             text primary key,           -- 'liquidator' | 'backrun-engine' | 'mis-scanner'
  chain               text,
  mode                text,
  uptime_sec          integer,
  gas_reserve_eth     double precision,
  gas_reserve_usd     double precision,
  adaptive_min_ev_usd double precision,
  auto_paused         boolean,
  motor_stats         jsonb,
  updated_at          timestamptz not null default now()
);
alter publication supabase_realtime add table public.service_status;
alter table public.service_status enable row level security;
create policy "service_status read" on public.service_status for select using (true);
```
> Escrita só via service role (rotas `/api`). Leitura pública (painel privado-por-URL), igual a `events`.

## Como aplicar (Humberto)
1. Abrir o **SQL Editor** do Supabase.
2. Rodar o `frontend/supabase/schema.sql` inteiro de novo (é idempotente: `create table if not exists`,
   `create policy` com `drop policy if exists`). Só cria o que falta (`service_status`).
3. Conferir em **Database → Replication** que `service_status` está no publication `supabase_realtime`.
4. Pronto — o painel passa a mostrar gás-agora, uptime, EV adaptativo e o **estado real do toggle**.

## Notas menores (sem ação obrigatória)
- `block_number` é `bigint`; o bot emite `blockNumber` como string numérica → o Postgres converte ok.
- Heartbeat **nunca** alerta (push/email) — o `/api/ingest` só notifica eventos de negócio.
