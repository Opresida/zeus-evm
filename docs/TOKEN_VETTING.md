# 🛂 Token Vetting Service — o porteiro de tokens

Serviço compartilhado pelos 2 motores que decide **quais tokens entram/saem do universo de trading**, com
observabilidade total no painel (tela **Tokens**: entrou/saiu + motivo em PT-BR simples). **100% off-chain — nenhum
contrato é tocado.** Plano aprovado 2026-06-30; entregue em fatias verticais (backend + frontend juntos).

## Política POR MOTOR (o núcleo)

| | **Motor 2 (arb / mis-scanner)** | **Motor 1 (liquidação / pré-liq)** |
|---|---|---|
| O token é | **ESCOLHIDO** por nós | **IMPOSTO** (colateral do tomador) |
| Pergunta | "é seguro **E** tem edge?" | "dá pra **VENDER** com segurança?" |
| Filtro de edge | **MANTÉM** (`NO_EDGE_TOKENS`) | **N/A** — LSDs aceitos (são o colateral da pré-liq) |
| `pass` exige | segurança + saída-DEX + liquidez + edge | segurança + saída-DEX + liquidez + não-honeypot |
| Fail-safe (dado parcial) | `reject` (não entra no que não dá pra verificar) | `pass` (nunca bloqueia liquidação lucrativa) |

O `vetToken` emite o **mesmo verdict**; a **política** (o que conta como `pass`) é parâmetro por motor.

## Como funciona (verdict)
`vetToken` compõe **só infra existente**: safety GoPlus/CoinGecko (`vetting/tokenSafety`+`tokenSafetyFilters`,
cache 24h) + rota de saída multi-DEX (`bestSwapAcrossDexes` → qual DEX) + piso de liquidez + lock. Verdict =
`pass`/`reject` + motivo PT-BR + 4 checks (segurança · saída+DEX · piso de liquidez · lock).

## Lock de liquidez — Tier 0 (feito) × Tier 1 (refinamento)
- **Tier 0 (feito, custo ZERO):** parseia o `lp_holders` que **já vem** na resposta do GoPlus → **% do LP travado**,
  **nome do locker** (UniCrypt/Team Finance) e **data de vencimento** (`locked_detail.end_time`). Antes usávamos só
  o booleano `topHolderIsLocked`. Flui no verdict (`lockStatus.pctLocked/locker/unlockIso`) → tracker → heartbeat →
  tela Tokens (🔒 % no hover) e é o que a **Atena** vigia na mainnet (lock vencendo / % caindo / locker suspeito).
- **Tier 1 (6b opcional, on-chain):** confirmação DIRETA na corrente pros tokens de MAIOR valor — ABI do locker via
  **BaseScan** (temos a key; ~4 chamadas na vida, cacheadas) + leitura via **RPC** (multicall, cache 6-12h, só o
  universo). Mais preciso (fonte da verdade), mais trabalho (ABI por-locker; NFT no UniV3). Custo mensal ≈ zero
  (BaseScan free 100k/dia, usamos ~4 no total; RPC já temos). Começar pelos pares UniV2/Aero (LP ERC20).

## Flags (env) × Toggles (painel)

| Flag env | Default | O que faz |
|---|---|---|
| `VETTING_ENABLED` | `false` | chave-mestra do porteiro |
| `VETTING_M2_OBSERVE` | `true` | (sob a mestra) veta o M2 e mostra no painel — **NÃO filtra** |
| `VETTING_M2_ENFORCE` | `false` | chave-mestra do **filtro** do M2 |
| `VETTING_SAFETY_CACHE_DIR` | `.cache` | onde fica o `token-safety-cache.json` |

O **liga/desliga AO VIVO** do filtro é o **toggle do painel** (botão admin) → tabela `engine_control` (linha
`vetting_m2_enforce`) → o bot faz poll. Mesmo mecanismo "armado-mas-travado" dos motores. **Claude nunca auto-liga.**
Fail-safe do toggle: erro/sem-config → filtro **desligado**.

## ⚠️ Independência dos toggles (importante)
"**Enviar TX**" (toggle do motor, `engine_control('motor2')`) e "**Filtro de tokens**" (`vetting_m2_enforce`) são
**independentes**:

| Enviar TX | Filtro | Envia? | Em quais tokens |
|---|---|---|---|
| OFF | qualquer | não | — |
| ON | OFF | **sim** | **TODOS** (universo cheio, **sem porteiro**) |
| ON | ON | sim | **só os aprovados** |

Dá pra enviar TX com o filtro desligado (comportamento "de antes"). O filtro é uma **camada extra**, não um
pré-requisito. (Decisão Humberto 2026-06-30: manter independente pra poder testar dos 2 jeitos. Há um interlock
opcional — "enviar TX exige filtro ligado" — disponível se um dia quiser.)

## Runbook observar → ligar
1. Subir com `VETTING_ENABLED=true` + `VETTING_M2_OBSERVE=true` → **observar** (painel mostra entrou/saiu, sem mexer no trade).
2. Acompanhar ≥ N dias: ver no painel se o porteiro está vetando certo.
3. Setar `VETTING_M2_ENFORCE=true` (chave-mestra) → o **botão admin** na tela Tokens aparece.
4. Apertar o botão quando confiar → o filtro liga ao vivo. **Em DRY_RUN não envia nada** (só treina num universo mais seguro).

## Estado das 7 etapas
- ✅ **1** — `vetToken`/`policy`/`reasons` + tela Tokens (read-only, DEMO).
- ✅ **2** — M2 **observar** + log entrou/saiu (`token.entered`/`token.exited`).
- ✅ **3** — M2 **enforce** (botão admin) → **Motor 2 fechado**.
- ⏳ **4** — M1 **observar** (colaterais: "dá pra vender com segurança?").
- ⏳ **5** — M1 **enforce** (botão admin) → Motor 1 fechado.
- ⏳ **6** — lock **on-chain** (Unicrypt/Team Finance) + liquidez **round-trip** + **re-vet contínuo** (auto-demote, tira o "restart").
- ⏳ **7** — histórico no DuckDB + hardening + sweep final.

## Arquivos
- `packages/execution-utils/src/vetting/` — `tokenVetting.ts`, `policy.ts`, `reasons.ts`, `universeTracker.ts`, `tokenSafety.ts`, `tokenSafetyFilters.ts`.
- `apps/mis-scanner/src/vettingObserve.ts` + wiring em `index.ts` (~L331) + config (`VETTING_*`).
- Frontend: `app/api/ingest/route.ts`, `lib/{types,live,viewModel,mockData}.ts`, `components/screens/Tokens.tsx`, `supabase/schema.sql`, `app/api/control/route.ts` (chave `vetting_m2_enforce`).

> **Sem contrato tocado** (ZeusLiquidator está apertado no EIP-170). Tudo é gate de software no universo off-chain.
