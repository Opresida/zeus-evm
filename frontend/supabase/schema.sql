-- ===== ZEUS Command — schema Supabase =====
-- Rode no SQL Editor do Supabase (uma vez).

-- ---------- tabela de eventos ----------
create table if not exists public.events (
  id              bigint generated always as identity primary key,
  type            text not null,
  severity        text,
  ts              timestamptz not null default now(),
  chain           text,
  mode            text,
  protocol        text,
  pair            text,
  tx_hash         text,
  borrower        text,
  profit_usd      double precision,
  gas_usd         double precision,
  net_profit_usd  double precision,
  profit_delta_bps integer,
  block_number    bigint,
  payload         jsonb not null default '{}'::jsonb
);

create index if not exists events_ts_idx        on public.events (ts desc);
create index if not exists events_type_idx      on public.events (type);
create index if not exists events_tx_hash_idx    on public.events (tx_hash);
create index if not exists events_protocol_idx   on public.events (protocol);

-- ---------- subscriptions de Web Push ----------
create table if not exists public.push_subscriptions (
  id           bigint generated always as identity primary key,
  endpoint     text not null unique,
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);

-- ---------- realtime ----------
-- habilita streaming de INSERT na tabela events
alter publication supabase_realtime add table public.events;

-- ---------- RLS ----------
alter table public.events enable row level security;
alter table public.push_subscriptions enable row level security;

-- leitura pública (anon) de eventos — painel é privado por deploy/URL;
-- aperte para `authenticated` se usar Supabase Auth.
drop policy if exists "events read" on public.events;
create policy "events read" on public.events
  for select using (true);

-- writes só via service role (rotas /api). Sem policy de insert para anon.

-- ---------- views de PnL ----------
create or replace view public.pnl_daily as
  select date_trunc('day', ts) as day,
         count(*) filter (where type = 'tx.confirmed')                       as ok,
         count(*) filter (where type = 'tx.reverted_on_chain')               as fail,
         coalesce(sum(net_profit_usd) filter (where type = 'tx.confirmed'),0) as gross_profit_usd,
         coalesce(sum(gas_usd),0)                                            as gas_usd,
         coalesce(sum(net_profit_usd),0)                                     as net_usd
  from public.events
  where type in ('tx.confirmed','tx.reverted_on_chain')
  group by 1 order by 1 desc;

create or replace view public.pnl_weekly as
  select date_trunc('week', ts) as week,
         coalesce(sum(net_profit_usd),0) as net_usd,
         count(*) as ops
  from public.events
  where type in ('tx.confirmed','tx.reverted_on_chain')
  group by 1 order by 1 desc;

create or replace view public.pnl_by_protocol as
  select protocol,
         coalesce(sum(net_profit_usd),0) as net_usd,
         count(*) as ops
  from public.events
  where type = 'tx.confirmed' and protocol is not null
  group by 1 order by 2 desc;
