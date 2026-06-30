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

-- ---------- estado ao vivo dos serviços (heartbeat) ----------
-- 1 linha por serviço (UPSERT). O heartbeat (~30s) NÃO vai pra `events` (inundaria a tabela +
-- o realtime, afogando as transações). O /api/ingest roteia type='zeus.heartbeat' pra cá.
-- Alimenta os gauges do painel: gás-agora, uptime, EV adaptativo e o ESTADO REAL do toggle (auto_paused).
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
  strategy_stats      jsonb,                      -- comparativo por estratégia: [{strategy,candidates24h,candidateProfitUsd24h,executed24h,netUsd24h}]
  discovery           jsonb,                      -- pulso do radar (item 2): {positions,dispatched,rejected,atIso}
  intel               jsonb,                      -- inteligência (item 3): {marketBribeP50Gwei,...,driftBps}
  updated_at          timestamptz not null default now()
);
-- migração (tabela já existe): adiciona as colunas sem quebrar.
alter table public.service_status add column if not exists discovery jsonb;
alter table public.service_status add column if not exists intel jsonb;
alter table public.service_status add column if not exists strategy_stats jsonb;

-- ---------- realtime ----------
-- habilita streaming de INSERT na tabela events + UPDATE/INSERT em service_status
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.service_status;

-- ---------- controle remoto de execução (toggle do painel → bot) ----------
-- 1 linha por motor. O bot LÊ (poll) `execution_enabled`; a escrita é EXCLUSIVA das rotas /api
-- (service role). Modelo armado-mas-travado: default = false (travado). Fail-safe: o bot só liga
-- com `true` exato; qualquer incerteza mantém travado.
create table if not exists public.engine_control (
  motor             text primary key,            -- 'motor2' (arb), depois 'motor1'/'motor3'
  execution_enabled boolean not null default false,
  desired_mode      text default 'mainnet' check (desired_mode in ('dryrun','testnet','mainnet')),
  updated_at        timestamptz not null default now(),
  updated_by        text
);

-- seed dos motores (idempotente) — todos começam TRAVADOS.
-- motor1 = liquidações (clássica + pré-liquidação Morpho); motor2 = arbitragem; motor3 = backrun.
insert into public.engine_control (motor, execution_enabled)
  values ('motor1', false), ('motor2', false), ('motor3', false)
  on conflict (motor) do nothing;

-- ---------- RLS ----------
alter table public.events enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.engine_control enable row level security;
alter table public.service_status enable row level security;

-- leitura pública do estado dos serviços (painel privado-por-URL). Escrita só via service role (/api/ingest).
drop policy if exists "service_status read" on public.service_status;
create policy "service_status read" on public.service_status
  for select using (true);

-- leitura do toggle pelo bot via anon key (RLS de leitura). Escrita só via service role (rotas /api).
drop policy if exists "engine_control read" on public.engine_control;
create policy "engine_control read" on public.engine_control
  for select using (true);
-- sem policy de insert/update para anon → escrita só pelo service role (bypassa RLS).

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

-- ============================================================================
--  AUTENTICAÇÃO — login MAZARI + cadastro por indicação com aprovação do admin
-- ============================================================================
-- O painel passa a exigir login (Supabase Auth). Cada conta nasce 'pending' e SÓ o admin aprova.
-- Cadastro é por LINK DE INDICAÇÃO (só o admin gera). Membro aprovado = só VÊ; armar o bot = só admin.

-- perfil 1:1 com auth.users (papel + status de aprovação)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  role        text not null default 'member' check (role in ('admin','member')),
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  invited_by  uuid,
  created_at  timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid
);

-- convites (links de indicação) — criados SÓ pelo admin, validados server-side (service role) no cadastro
create table if not exists public.invites (
  token       text primary key,
  created_by  uuid,
  note        text,
  used_by     uuid,
  used_at     timestamptz,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists invites_unused_idx on public.invites (token) where used_at is null;

-- helper: o uid logado é admin aprovado? (SECURITY DEFINER evita recursão de RLS na própria profiles)
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.status = 'approved'
  );
$$;

alter table public.profiles enable row level security;
alter table public.invites  enable row level security;

-- profiles: cada um lê o PRÓPRIO; admin lê todos e atualiza (aprovar/rejeitar). Escrita de criação é
-- só via service role (rota /api/auth/signup). Sem policy de insert pra usuário comum.
drop policy if exists "profiles read own"  on public.profiles;
create policy "profiles read own"  on public.profiles for select using (auth.uid() = id or public.is_admin());
drop policy if exists "profiles admin update" on public.profiles;
create policy "profiles admin update" on public.profiles for update using (public.is_admin());

-- invites: só admin lê/gera pelo cliente (a validação no cadastro é server-side via service role, que bypassa RLS).
drop policy if exists "invites admin all" on public.invites;
create policy "invites admin all" on public.invites for all using (public.is_admin()) with check (public.is_admin());

-- ---------- aperto de leitura: dados sensíveis agora exigem login (authenticated) ----------
-- (o schema já sugeria isso). engine_control SEGUE público — o BOT lê com anon key.
drop policy if exists "events read" on public.events;
create policy "events read" on public.events for select to authenticated using (true);

drop policy if exists "service_status read" on public.service_status;
create policy "service_status read" on public.service_status for select to authenticated using (true);

-- wallet_snapshots: se existir no seu projeto, aperte também (rode manualmente; não está neste schema):
--   alter table public.wallet_snapshots enable row level security;
--   drop policy if exists "wallet_snapshots read" on public.wallet_snapshots;
--   create policy "wallet_snapshots read" on public.wallet_snapshots for select to authenticated using (true);

-- ---------- SEED do admin (one-time) ----------
-- 1) Supabase → Authentication → Add user: humbertodeassuncao@gmail.com + senha (marque "Auto Confirm User").
-- 2) Pegue o UID criado e rode (troque <ADMIN_UID>):
--   insert into public.profiles (id, email, role, status, approved_at)
--     values ('<ADMIN_UID>', 'humbertodeassuncao@gmail.com', 'admin', 'approved', now())
--     on conflict (id) do update set role='admin', status='approved';
