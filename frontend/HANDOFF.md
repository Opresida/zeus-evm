# HANDOFF — ZEUS Command (frontend)

> Documento de intenção e contexto desta branch (`claude/bot-performance-analysis-55qp9o`).
> Lido por humanos **e** pelo Claude no Antigravity. Leia isto antes de mexer no `frontend/`.

---

## 🎯 Intenção

Construir um **frontend próprio do ZEUS** — o **ZEUS Command** — que **espelha idealmente o
backend** (os 3 motores + camada de inteligência/OIE) num painel de controle em tempo real,
**mobile-first e instalável (PWA)**, hospedado no **Vercel**.

O objetivo é o Humberto **operar o bot pelo celular/desktop**: ver transações que deram certo (com
hash), as que falharam, lucro diário/semanal/mensal, gás na carteira, auto-calibração, emitir
relatórios e receber **notificações profissionais** (Web Push + Email — sem Telegram).

O design foi feito pelo Humberto no Claude Design tool (`ZEUS Command.dc.html`) e **já está
implementado** aqui como app Next.js real (build + typecheck passando).

---

## 🔌 Como vai funcionar (a ponte de dados)

O ZEUS **não tem API JSON de negócio** — expõe só `/healthz`, `/readyz`, `/metrics` (Prometheus) e
um **`genericWebhookSink`** que faz **POST de cada `ZeusEvent` (JSON) pra uma URL**. O DuckDB é
arquivo local na máquina do bot (Fly.io), inacessível ao Vercel. Por isso a arquitetura é:

```
ZEUS (Fly.io)
  └─ genericWebhookSink  --POST JSON (cada evento)-->  /api/ingest (Vercel, valida x-zeus-secret)
                                                          └─> Supabase (Postgres + Realtime)
ZEUS Command (Next.js PWA no Vercel)  <-- Supabase Realtime + REST -->  painel + Web Push + Email
```

- O bot POSTa eventos → `/api/ingest` valida o segredo, grava no Supabase e faz fan-out de
  push/email pros eventos críticos.
- O painel assina o **Realtime** do Supabase e atualiza ao vivo.
- **Contrato de eventos:** espelha `packages/execution-utils/src/events.ts`. A tipagem está em
  [`lib/types.ts`](./lib/types.ts) e a derivação evento→UI em [`lib/live.ts`](./lib/live.ts).

---

## ✅ O que JÁ funciona

- **8 telas** fiéis ao design: Visão geral · Transações (hash → Basescan) · Lucro & PnL ·
  Carteira & Gás · Inteligência · Saúde · Relatórios (CSV/PDF) · Configurações. Temas Navy/Preto.
- **Build e typecheck passando** (`next build` + `tsc --noEmit`).
- **Modo demo:** sem Supabase configurado, o painel roda com os dados representativos do design —
  abre completo e bonito **sem backend** (ótimo pra preview/Vercel imediato).
- **Pipeline pronto:** `/api/ingest` (HMAC), `/api/push/subscribe`, `/api/test` (injeta eventos),
  service worker + manifest (PWA), schema SQL do Supabase.

---

## 🟡 O que FALTA pra funcionar "de verdade" (dados reais)

1. **Provisionar Supabase** — criar projeto, rodar [`supabase/schema.sql`](./supabase/schema.sql),
   pegar as 3 keys.
2. **Gerar VAPID** (`npx web-push generate-vapid-keys`) pro Web Push.
3. **Configurar env vars** (ver [`.env.example`](./.env.example)) no Vercel + local.
4. **Deploy no Vercel** com **Root Directory = `frontend`**.
5. **Cola no backend do ZEUS** (2 ajustes pequenos — ainda NÃO feitos):
   - **(a) Header de segredo:** `packages/execution-utils/src/alerting/genericWebhookSink.ts` hoje
     POSTa JSON puro. Adicionar o header `x-zeus-secret` (lê de `GENERIC_WEBHOOK_SECRET`) pra o
     `/api/ingest` validar. (~5 linhas.)
   - **(b) Heartbeat:** emitir um `zeus.heartbeat` periódico (reaproveitando o `metricsSyncInterval`
     dos apps) com `gasReserveEth/Usd`, `uptimeSec`, `adaptiveMinEvUsd`, `autoPaused`, `motorStats`.
     Sem ele, gás-ao-vivo/uptime/min-EV caem no fallback do design.
6. **Apontar o bot:** setar `GENERIC_WEBHOOK_URL=https://<app>.vercel.app/api/ingest` +
   `GENERIC_WEBHOOK_SECRET` + `GENERIC_SEVERITIES` nos `.env` dos apps.

> **Importante (honestidade):** mesmo com tudo isso, KPIs do dia, ticker, transações, gás e log do
> sistema são derivados dos eventos reais; mas **gráficos históricos** (14d, séries de PnL) e parte
> da tela de **Inteligência** seguem usando os dados do design até o backend emitir histórico/séries.
> Ver `lib/live.ts` (o que é "live" hoje está marcado lá).

---

## 🤖 Para o Claude no Antigravity (contexto pra continuar)

Se você é o Claude rodando no Antigravity e vai mexer aqui:

- **O frontend é um app STANDALONE** em `frontend/` — tem `package.json` próprio e **não faz parte do
  pnpm workspace** do monorepo. Instale com `pnpm install --ignore-workspace` (de dentro de
  `frontend/`). Rode com `pnpm dev`. **Não** misture com o `pnpm install` da raiz.
- **Não toque** em `contracts/`, `apps/`, `packages/` por causa do frontend — a ponte é só o
  webhook. A única mudança no backend é a **cola** do item 5 (a/b) acima, quando for a hora.
- **Padrões do app:**
  - Estilos portados do design via helper `lib/css.ts` (`css("...")` converte string CSS → objeto
    React) + componente `components/ui.tsx` (`Hover`) pros `style-hover`.
  - Tema em `app/globals.css` (variáveis `--bg/--gold/...` navy/black).
  - Lógica de dados: `lib/viewModel.ts` (porte do `renderVals()` do design) + `lib/live.ts`
    (eventos Supabase → UI) + `lib/mockData.ts` (fallback do design).
  - Telas em `components/screens/*.tsx`, orquestradas por `components/Dashboard.tsx`.
- **Próximas tarefas naturais (em ordem):**
  1. Provisionar Supabase + env + deploy Vercel (modo demo já funciona sem isso).
  2. Fazer a cola do backend (`x-zeus-secret` + `zeus.heartbeat`).
  3. Evoluir `lib/live.ts` pra derivar mais campos reais (7d/30d, séries, intel) conforme o
     backend passar a emitir histórico — substituindo o fallback do design progressivamente.
  4. (Opcional) Trocar o ícone SVG por PNGs 192/512 e adicionar Supabase Auth (magic link) se quiser
     travar o acesso por login além da URL privada.
- **Antes de "concluído":** rodar `pnpm typecheck` e `pnpm build` dentro de `frontend/`.

---

## 🗂️ Mapa rápido

| Caminho | O quê |
|---|---|
| `app/api/ingest/route.ts` | Recebe eventos do bot (valida `x-zeus-secret`) → grava no Supabase + fan-out push/email |
| `app/api/push/subscribe/route.ts` | Salva subscription de Web Push |
| `app/api/test/route.ts` | Injeta eventos de exemplo (`?type=tx.confirmed`) pra validar o pipeline |
| `components/Dashboard.tsx` | Topbar + sidebar + Realtime + roteamento das 8 telas |
| `components/screens/*` | Home · Transactions · Pnl · Wallet · Intelligence · Health · Reports · Settings |
| `lib/types.ts` | Contrato dos `ZeusEvent` (espelha `execution-utils/events.ts`) |
| `lib/live.ts` | Deriva KPIs/ticker/tx/log dos eventos reais |
| `lib/viewModel.ts` `lib/mockData.ts` | View-model + fallback do design |
| `supabase/schema.sql` | Tabelas `events`/`push_subscriptions` + RLS + Realtime + views de PnL |
| `README.md` | Setup completo + deploy + testes |

**TL;DR:** o frontend está pronto e roda em modo demo. Pra dados reais: Supabase + Vercel + a cola do
backend (webhook secret + heartbeat). Detalhes de setup no `README.md`.
