# ZEUS Command

Painel de controle em tempo real do bot **ZEUS** — implementação do design `ZEUS Command.dc.html`.
Next.js 14 (App Router) + Supabase (Postgres + Realtime) + Web Push (PWA) + Email (Resend).
Mobile-first e instalável. Deploy no Vercel.

## O que tem

8 telas (fiéis ao design): **Visão geral · Transações · Lucro & PnL · Carteira & Gás ·
Inteligência · Saúde · Relatórios · Configurações**. Temas Navy/Preto, ticker ao vivo, export
CSV/PDF, notificações Web Push + Email.

> **Modo demo:** sem Supabase configurado, o painel roda com os dados representativos do design.
> Com Supabase + o webhook do bot apontado pra `/api/ingest`, tudo vira **tempo real**.

## Arquitetura (a ponte de dados)

```
ZEUS (Fly.io) --genericWebhookSink POST JSON--> /api/ingest (Vercel, valida x-zeus-secret)
                                                   └─> Supabase (Postgres + Realtime)
Painel (Next.js PWA) <-- Supabase Realtime --> UI + Web Push + Email
```

O bot já tem o `genericWebhookSink` que POSTa cada `ZeusEvent`. Basta apontá-lo aqui.

## Setup

### 1. Supabase
1. Crie um projeto em supabase.com.
2. SQL Editor → cole e rode [`supabase/schema.sql`](./supabase/schema.sql).
3. Settings → API → copie `URL`, `anon key` e `service_role key`.

### 2. VAPID (Web Push)
```bash
npx web-push generate-vapid-keys
```
Copie a public/private key.

### 3. Env vars
Copie `.env.example` → `.env.local` e preencha (Supabase, VAPID, Resend, secret do webhook).

### 4. Rodar
```bash
cd frontend
npm install      # (este app é standalone; não usa o pnpm workspace do ZEUS)
npm run dev      # http://localhost:3000
```

### 5. Deploy (Vercel)
- Importe o repo no Vercel, **Root Directory = `frontend`**.
- Configure as mesmas env vars no painel do Vercel.
- Deploy.

### 6. Conectar o bot ZEUS
No `.env` dos apps do ZEUS:
```
GENERIC_WEBHOOK_URL=https://<seu-app>.vercel.app/api/ingest
GENERIC_WEBHOOK_SECRET=<o mesmo ZEUS_WEBHOOK_SECRET>   # ver nota abaixo
GENERIC_SEVERITIES=info,warn,critical
```
> **Nota:** o `genericWebhookSink` atual POSTa JSON puro. Pra enviar o header `x-zeus-secret`,
> aplique a cola descrita no plano (`packages/execution-utils/src/alerting/genericWebhookSink.ts`).
> Enquanto isso, deixe `ZEUS_WEBHOOK_SECRET` vazio (ingest aceita sem auth) **ou** use uma URL secreta.

## Testar o pipeline end-to-end

Com Supabase + envs configurados:
```bash
# injeta um evento de exemplo (aparece no painel em realtime + dispara push)
curl https://<seu-app>.vercel.app/api/test?type=tx.confirmed
curl https://<seu-app>.vercel.app/api/test?type=gas.alert       # crítico → push + email
curl https://<seu-app>.vercel.app/api/test?type=zeus.heartbeat  # atualiza gás/uptime ao vivo
```

## Notas

- **Live vs. representativo:** KPIs do dia, ticker, transações, gás e log do sistema são derivados
  dos eventos reais quando há dados. Gráficos históricos (14d, séries de PnL) e parte da tela de
  Inteligência usam os dados do design até o backend emitir histórico/series — ver `lib/live.ts`.
- **Heartbeat:** pra gauges ao vivo (gás agora, uptime, min EV adaptativo) o bot deve emitir
  `zeus.heartbeat` periódico. Sem ele, esses campos caem no fallback do design.
- **PWA:** `manifest.webmanifest` + `public/sw.js`. Ícone em SVG (`public/icons/icon.svg`) — troque
  por PNGs 192/512 se quiser apple-touch-icon raster.
- **Push iOS:** requer o app instalado na tela inicial (PWA) e iOS 16.4+.

## Estrutura

```
frontend/
├── app/
│   ├── layout.tsx · page.tsx · globals.css
│   └── api/
│       ├── ingest/route.ts         # recebe eventos do bot (HMAC/secret) → Supabase + fan-out
│       ├── push/subscribe/route.ts # salva subscription de Web Push
│       └── test/route.ts           # injeta eventos de exemplo
├── components/
│   ├── Dashboard.tsx               # topbar + sidebar + realtime + roteamento de telas
│   ├── ui.tsx                      # helper de hover
│   └── screens/                    # Home · Transactions · Pnl · Wallet · Intelligence · Health · Reports · Settings
├── lib/
│   ├── css.ts viewModel.ts live.ts mockData.ts types.ts
│   ├── supabaseClient.ts supabaseServer.ts notify.ts push.ts
├── public/ (sw.js · manifest · icons)
└── supabase/schema.sql
```
