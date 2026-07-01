# CLAUDE.md — ZEUS EVM

Pacote de contexto portátil para Claude Code. Auto-carregado em qualquer máquina onde este repo for clonado.

---

## 👤 Quem é o usuário

**Humberto** (humbertodeassuncao@gmail.com) — fundador da MAZARI CORP. Plano Claude Max. Usa **Antigravity IDE** no Windows.

### Preferências fortes
- **Nunca abrir Simple Browser nem browser embutido** — apenas informar URL
- **PT-BR direto**, vocativo "meu amigo" é OK
- **Respostas curtas e objetivas**, sem floreio
- **Honestidade > otimismo cego** — sempre flag limites e riscos

---

## 🎯 O que é o ZEUS EVM

Bot de arbitragem on-chain em EVM. **Duas modalidades:**
1. **Wallet arb** — capital próprio do bot
2. **Flashloan arb** — multi-fonte 0% (Morpho + Balancer primário, Aave V3 0.05% fallback)

**Três motores descorrelacionados:**
- **Motor 1 — Liquidations** (Aave V3 + Compound III + Morpho Blue + Seamless + Moonwell)
- **Motor 2 — MIS scanner → motor de execução cross-DEX** (varredura de ineficiências ranqueada por persistência + execução cross-DEX/triangular; **execução DESLIGADA por default** — `ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun`)
- **Motor 3 — Backrun** (backrun pós-whale, competitor-aware com bribe + relays)

**Estratégias de arb (motor de execução compartilhado):**
- Cross-DEX em medium-cap tokens
- Triangular / multi-hop N steps (Uniswap V3 fee tiers)

**Chain inicial:** Base (Coinbase L2). Multi-chain depois.

> Projeto exclusivo Humberto + Claude. Danton NÃO está envolvido.

---

## 🧱 Stack

- **Off-chain:** TypeScript + Node 22 + `viem`
- **Smart contracts:** Solidity 0.8.27 + Foundry (via_ir, optimizer 1M runs)
- **Monorepo:** pnpm 10+ workspaces (pnpm-only — npm install é bloqueado)
- **Provider:** Alchemy primário (archive incluso no free tier) + fallback a definir (dRPC free descartado — não serve archive)
- **Flashloan:** multi-fonte 0% — Morpho + Balancer primário, Aave V3 0.05% fallback
- **Intelligence:** ledger DuckDB (camada OIE — scoring + observações)
- **Deploy:** Fly.io (Dockerfile raiz + `deploy/fly/*.toml` com volume persistente)
- **Monitoring:** Tenderly + Discord webhook + pino logs + Prometheus + Grafana

---

## 🚀 Como rodar

```bash
cd /c/Users/user/zeus-evm

# Setup inicial (1ª vez)
pnpm install

# Foundry: instalar libs
cd contracts
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install Uniswap/v3-core --no-commit
forge install Uniswap/v3-periphery --no-commit
forge install aave/aave-v3-core --no-commit
cd ..

# Build contratos
pnpm contracts:build

# Tests
pnpm contracts:test

# Typecheck TS
pnpm typecheck
```

**Não abrir browser** — projeto é CLI + bot, sem UI até dashboard futuro.

---

## ✅ Princípios não-negociáveis

### Risco e segurança
1. **Atomic-only** — qualquer falha reverte a tx inteira
2. **Self-custody com circuit breakers no contrato** — `MAX_TRADE_ETH` + `minProfitWei` + kill switch
3. **Owner = multisig** (Safe Wallet) em produção
4. **Sem reuso de chave** entre projetos — chave do Zeus EVM é exclusiva
5. **Validar antes de escalar** — testnet 2 semanas → mainnet capital pequeno 4 semanas → audit → scale

### Código
1. **`pnpm typecheck && pnpm contracts:test` antes de "concluído"**
2. **`pnpm install` é proibido** — preinstall hook bloqueia
3. **Adapters DEX modulares** — 1 arquivo por DEX, interface comum
4. **Custom errors > require strings** (gas)
5. **NatSpec em funções públicas**
6. **Sem proxies upgradeable** — bug = deploy novo (intencional)

### Voz
- PT-BR direto
- Sem hype crypto-bro
- Sempre flag riscos antes de implementar
- "Posso entregar mas precisa audit antes de capital alto" é honesto

---

## 🔒 Regras invioláveis

- ❌ **Nunca** `npm install` neste repo
- ❌ **Nunca** commitar `.env` (use `.env.example`)
- ❌ **Nunca** deploy mainnet sem audit interno + testnet 2 semanas mínimo
- ❌ **Nunca** assumir que mainnet "vai funcionar" sem testar em fork
- ❌ **Nunca** reusar `EXECUTOR_PRIVATE_KEY` entre dev e prod
- ❌ **Nunca** modificar `MAX_TRADE_ETH` em runtime sem timelock
- ❌ **Nunca** skipar testes com `--skip`
- ❌ **Nunca** chamar adapter não-aprovado (`approvedDexAdapters`)
- ❌ **Nunca** acessar mainnet sem `KILL_SWITCH=false` deliberado

---

## 📁 Estrutura

```
zeus-evm/
├── contracts/              # Foundry — split por EIP-170 (4 contratos, antes era ZeusExecutor monolítico)
│   ├── src/ZeusArbExecutor.sol          # executeArbitrage + executeFlashloanArbitrage +
│   │                                    # executeFlashloanBackrun (multi-hop N steps = triangular;
│   │                                    # flashloan 3 fontes Aave/Morpho/Balancer)
│   ├── src/ZeusLiquidator.sol           # Liquidation (Aave) + Compound + Morpho (+ variantes WithBribe)
│   ├── src/ZeusMoonwellLiquidator.sol   # executeMoonwellLiquidation
│   ├── src/BribeManager.sol             # gestão de bribe pro motor 3
│   ├── src/libraries/                   # UniswapV3Lib + AerodromeLib (inline adapters)
│   ├── src/interfaces/                  # IZeusArbExecutor/IZeusExecutor/IZeusLiquidator/
│   │                                    # IZeusMoonwellLiquidator/IBribeManager
│   │                                    # + aave/balancer/compound/moonwell/morpho
│   ├── script/Deploy.s.sol              # multi-chain (Base, Arb, OP — mainnet + Sepolia)
│   └── test/                            # 115 funções de teste (9 arquivos: 4 unit + 5 fork)
│       ├── ZeusArbExecutor.t.sol  ZeusLiquidator.t.sol  ZeusMoonwellLiquidator.t.sol  BribeManager.t.sol
│       └── fork/                        # ZeusArbExecutor + ZeusLiquidator + BribeManager (+B6B7) + MotorsProfit
├── apps/                   # 7 apps
│   ├── detector/           # TS — radar arb cross-DEX DRY_RUN; consome getTargetPairsForChain (varredura)
│   │                       #      + grava no ledger DuckDB (arb_observed)
│   ├── liquidator/         # MOTOR 1 — pipeline completo; Aave V3 + Compound III + Morpho Blue +
│   │                       #           Seamless (fork Aave) + Moonwell; EV gate ciente de OEV (prioriza Morpho)
│   │   ├── src/protocols/aave|compound|moonwell|morpho/   # calc + sim + builder por protocolo
│   │   ├── src/alerting/   # discordSink + genericWebhookSink (subscribers do eventBus)
│   │   ├── src/pipeline.ts # runners Aave/Compound/Morpho/Moonwell + gates pre-dispatch + score pós-OEV
│   │   └── src/dispatcher.ts  # 3 modos: dryrun | testnet | mainnet + EIP-1559
│   ├── mis-scanner/        # MOTOR 2 — motor de execução cross-DEX (varredura multicall + derivação de
│   │                       #           colaterais até 60 pares + flash sizing + Trader Joe LB + detecção
│   │                       #           triangular findTriangularCycles); ranqueia por persistência;
│   │                       #           arbDispatcher/arbOpportunity (execução OFF default → só grava
│   │                       #           mis_observed) + inteligência espelhada (EventBus/PnL/competitor)
│   ├── backrun-engine/     # MOTOR 3 — backrun pós-whale; EV gate competitor-aware (gas war) + bribe +
│   │                       #           relays; grava no ledger
│   ├── discovery-scraper/  # TS — varredura dinâmica GeckoTerminal → auto-targets.json + token safety GoPlus
│   ├── monitor/            # TS — DRY_RUN discovery Aave+Compound+Morpho (read-only)
│   └── backtest/           # TS — replay histórico de blocos
├── packages/              # 6 packages
│   ├── chain-config/       # BASE_MAINNET + BASE_SEPOLIA + ARBITRUM + OPTIMISM + target-pairs
│   ├── dex-adapters/       # quoteUniswapV3 + quoteAerodrome (off-chain pricing)
│   ├── strategy/           # opportunities (crossDex/filters/fanout) + executor (txBuilder/simulator/abi)
│   ├── aave-discovery/     # package shared (ABIs + reserves cache + discovery + types) reusável
│   ├── execution-utils/    # PACOTE GRANDE — trackers (pnl/failure/dedup/gas) + gasOracle + eventBus/events + walletPool (M1+M2)
│   │                       #   + intelligence DuckDB (TimeseriesStore + EventIngester + observation)
│   │                       #   + pnlReconciler/attribution + failureCollector + senderRegistry
│   │                       #   + scoring (chainProfitability/opportunity/dimension/dimensionStatsQuery)
│   │                       #   + prometheus + health + MarketInefficiencyScanner + bribeSlippageFloor + Tracer
│   └── shared-types/
├── docs/                   # OIE_PROGRESS + FIRST_FLIGHT + INFRA_EVOLUTION + MOTOR3_REFIT + NO_EDGE_TOKENS + ATENA_AGENT_DESIGN + grafana/
│   └── refs/               # MDs externos pra expandir conhecimento da IA
├── frontend/               # ZEUS Command — painel Next.js (Vercel) que espelha o backend.
│                           # App STANDALONE (package.json próprio, FORA do pnpm workspace;
│                           # instalar com `pnpm install --ignore-workspace`). Ponte de dados:
│                           # bot genericWebhookSink → /api/ingest → Supabase Realtime → painel
│                           # + Web Push/Email. LER frontend/HANDOFF.md ANTES de mexer.
└── deploy/fly/             # Dockerfile raiz + detector/liquidator/mis-scanner.toml (volume persistente)
```

---

## ✅ SESSÃO 2026-07-01 (noite) — Chave-mestra de execução + Automações Parte 3 (Levas 1-2) (tudo mergeado na `main`)

Sessão grande de **automação "viva"** (o bot se auto-ajusta dentro de travas + avisa + reversível) + a
**chave-mestra de execução**. **Regra honrada:** Claude NUNCA auto-liga execução; tudo observe-first, mock
espelha o AO VIVO, teste RPC profundo a cada leva. **Vários merges na `main`, sweep verde a cada um.**

**🔑 Chave-mestra de execução (o toggle do painel acende o "pacote de combate"):** ao ligar "enviar TX" de um
motor (`liveExecutionEnabled` via `engine_control`), acende JUNTO: adaptive thresholds + bribe competitivo +
wallet-pool. Env vira **override force-on** (`liveExecutionEnabled || env.*`); default segue o toggle. **Vetting
fica INDEPENDENTE** (decisão do Humberto). Painel (Configurações) mostra o pacote via `combatBundle` no heartbeat.
- **Fase A** — adaptive + bribe competitivo seguem o toggle (M1 4 call-sites + M2 arbDispatcher).
- **Fase B** — **wallet-pool REALOCADO** `apps/liquidator/src/walletPool` → `packages/execution-utils/src/walletPool`
  (compartilhado M1+M2). **Motor 2 ganha dispatch PARALELO** (N frentes, uma carteira/nonce por oportunidade,
  `Promise.all`). 🐛 **FIX CRÍTICO de corrida** no `orchestrator.acquire` (2 acquire paralelos pegavam a MESMA
  carteira/nonce → "nonce too low"): reserva o slot ANTES do await + re-checa `requiresSync` DEPOIS. Provado:
  size 2 → carteiras distintas; size 1 → nonces 9,10. + M2 usa o **nonce explícito** do pool (igual M1).
- **Fase C** — painel mostra o pacote de combate (Motor 2).

**🤖 Automações (Parte 3, relatório de 14) — Levas 1 e 2 feitas (5 de 14):**
- **#1 Piso de EV auto-calibrável OBSERVÁVEL** — o adaptive já existia (opt-in) mas quando OFF só logava; agora
  emite `calibration.applied` nos 2 modos com flag `applied` → card "o que faria" no DRY_RUN. Injeção segue gated.
- **#2 RPC degradado visível** — destrava o `warn` do `BlockStalenessCheck` → componente tri-estado (verde/amarelo/vermelho).
- **#3 Escalada de gás do competidor** — p95 do market-bribe sobe >50% + ≥2 competidores → banner (Inteligência).
- **#4 Cooldown adaptativo** — backoff = base × (1+cooldowns), teto 30min, histerese; observe-first (`ADAPTIVE_COOLDOWN_ENABLED`).
- **#6 Edge sumindo** — soma dos top-5 scores cai ≥30% em ~1h → banner (possível novo competidor).
- **#5 slippage por DEX — ADIADO**: precisa dado real de swap. **Ideia do Humberto (aprovada): usar o Dune** — recortar
  histórico de trades da Base, medir impacto por DEX × tamanho (p95), calibrar o `MAX_SLIPPAGE_BPS` por-DEX SEM esperar
  mainnet. Vira o 1º caso de uso do feed de inteligência do Dune (ver `docs/AUTOMACOES.md`).
- **Faltam:** Leva 3 (#7 quarentena token · #8 pool depth · #9 calibração de gás) · Leva 4 (#10-12) · Leva 5 (#13-14).

**Verde final (RPC ON):** typecheck 0 · execution-utils 392 · liquidator 98 (18 testes walletPool realocados p/
execution-utils) · mis-scanner 52 · frontend 43 + tsc 0 + `next build` · `forge test` 191 (contratos INTOCADOS).
**Branches mergeadas+apagadas.** Detalhe em `docs/AUTOMACOES.md`.

---

## ✅ SESSÃO 2026-07-01 — Fios soltos do painel: prontidão da Saúde + Parte 2 + fios da Saúde (tudo mergeado na `main`)

Sessão de **observabilidade honesta** — pente-fino de "fios soltos" (dado que o bot já coleta mas não chega ao
painel) + prontidão completa da aba Saúde. **3 agentes** de auditoria (fios soltos frontend, cards da Saúde,
automações). **Tudo 100% off-chain, mock sempre espelhando o AO VIVO** (regra nova do Humberto — ver `feedback_mock_mirrors_live`).
**2 merges na `main`** (`claude/health-readiness` + `claude/health-loose-wires`), reteste completo verde a cada um.

**Bloco 1 — Prontidão dos componentes (aba Saúde), de 4 → até 9 bolinhas rotuladas por motor:**
- **RPC vivo** (`M1/M2 · rpc / Base`) — reusa o `BlockStalenessCheck` (0 chamada extra); vermelho "sem resposta" se cai.
- **Porteiro de tokens** — freshness do re-vet (verde "checado há Xs" / vermelho "re-vet parado").
- **Motor 2 antes INVISÍVEL** agora reporta prontidão própria; `live.ts` **funde os componentes dos 2 motores** (antes só um).
- **Saúde M2 completa** (paridade com M1): +reorg (finalityTracker) +perda 24h (pnlTracker, nome honesto — autoKill OFF)
  +gás-reserva (**novo `GasReserveTracker` no M2**, monitorando read-only a EOA via `botAccount`).

**Bloco 2 — Parte 2 dos fios soltos (6 itens acionáveis, 100% feitos):**
- **partial** (selo "⚠ dados parciais" na tela Tokens); **`decimals` ELIMINADO** (o bot nunca lê o universo de volta → peso morto).
- **arb cross-DEX vira estratégia visível** (`StrategyKey 'arb'`) — o M2 alimenta `candidate('arb', netProfit)` na varredura →
  tela Estratégias mostra o POTENCIAL do arb em DRY_RUN (antes morria no ledger).
- **saldo/gás em US$ no DRY_RUN** — novo `ctx.watchAccount` (só-leitura, deriva da chave; nunca assina) → check de gás popula.
- **perda de corrida nunca anônima** — `failure.recorded` passa a emitir `competitorSender`+`winnerPriorityFeeGwei`;
  painel mostra alias → endereço curto → "desconhecido" (revert técnico sem vencedor segue fora do post-mortem).
- **diagnóstico de concorrência** (builders dominantes + posição no bloco) do log → card novo na aba **Inteligência**
  (`HeartbeatCompetition`; `BlockPositionTracker` ganhou janela rolante + `summary()`).

**Bloco 3 — Fios soltos da própria aba Saúde:**
- **Taxa de erro real** (do `FailureTracker` via `errorMetrics` no heartbeat; "—" honesto em DRY_RUN, sem inventar).
- **Uptime real** no AO VIVO (o heartbeat já trazia `uptimeSec`; o painel ignorava).
- **Radar de descoberta multi-motor** (o M2 passa a emitir pulso próprio; `live.ts` mostra o serviço **mais fresco**, rotulado).

**Correções de rota honestas (o agente superestimou):** o filler JÁ estava ligado; a "conversão USD" JÁ existia;
`decimals` era peso morto. Sempre verificado antes de codar.

**Verde (RPC ON, 0 skip):** typecheck 0 · execution-utils 368 · liquidator 116 · mis-scanner 52 · frontend 41 + tsc 0 +
`next build` · **forge test 191 (contratos INTOCADOS)**. **Pendente: só cosméticos 7–11** (drift-alerts no painel, wonVsUs
type-safety, histórico de edge-pairs, motivo de bribe, ActivityPatternTracker) — baixo valor, deixados pro final.
**Branches mergeadas+apagadas.** Detalhe em `docs/PAINEL_FIOS_SOLTOS.md`.

---

## ✅ SESSÃO 2026-06-30→07-01 — Token Vetting Service (porteiro de tokens) COMPLETO 7/7 (mergeado na `main`)

**Plano APROVADO** (`~/.claude/plans/...parasol.md`): porteiro de tokens compartilhado pelos 2 motores que decide
quem ENTRA/SAI do universo de trading, com observabilidade total no painel (entrou/saiu + motivo PT-BR simples),
em **fatias verticais** (backend+frontend juntos), **sem perder o EDGE** e **sem tocar contrato** (100% off-chain).
**Decisões do Humberto:** M2 completo primeiro → depois M1; **observar antes de filtrar** (cultura DRY_RUN);
lock **leve→profundo** (flag GoPlus agora, on-chain depois); o filtro liga por **botão admin** (`engine_control`),
Claude nunca auto-liga. **Toggles independentes:** "Enviar TX" (motor) e "Filtro de tokens" (vetting) NÃO dependem
um do outro — dá pra enviar TX com o filtro off (universo cheio, sem porteiro). Humberto quer testar dos 2 jeitos.

**Política por motor (o núcleo):** M2 (arb) = token ESCOLHIDO → exige segurança+saída+liquidez+**edge**; M1 (liq) =
token IMPOSTO (colateral) → "dá pra VENDER com segurança?" (sem filtro de edge; LSDs aceitos). Mesmo verdict, política
parametrizada. Fail-safe: dado parcial → M1 `pass` (nunca bloqueia liquidação lucrativa), M2 `reject`.

**Todas as 7 etapas na `main` (verde a cada etapa; sem contrato tocado):**
- **1** — `vetToken(opts,deps)` compõe safety GoPlus + saída multi-DEX (`bestSwapAcrossDexes`) + piso de liquidez +
  lock; `policy.ts`/`reasons.ts` (PT-BR); safety realocado de `apps/discovery-scraper` → `packages/execution-utils/src/vetting`.
  Tela **"Tokens"** ponta-a-ponta (schema `vetted_universe` → ingest saneado → live → viewModel → `Tokens.tsx` → NAV).
- **2** — M2 **observar** (`runVettingObserve`; eventos `token.entered`/`token.exited` anti-flicker → log "Entrou/Saiu").
- **3** — M2 **enforce** (botão admin `engine_control('vetting_m2_enforce')`) → **Motor 2 fechado**.
- **4** — M1 **observar** (colateral: "dá pra vender com segurança?", sem filtro de edge; heartbeat do liquidator
  funde `vettedUniverse` com o do mis-scanner).
- **5** — M1 **enforce** (botão admin `engine_control('vetting_m1_enforce')`, fail-safe: parcial não bloqueia) → **Motor 1 fechado**.
- **6** — liquidez **round-trip** (USDC→token→USDC, `VETTING_MAX_ROUNDTRIP_BPS`) + **re-vet contínuo** (`runRevetTick`,
  auto-demote/promote — "porteiro vivo", tira o restart) + lock rico **Tier 0** (parseia `lp_holders` do GoPlus: % travado,
  locker, data de unlock — custo ZERO).
- **7** — **histórico no DuckDB** (`token.*` → categoria `token_vetted` via EventIngester) + hardening (cada emit isolado
  em try/catch) + docs + sweep + merge.

**Toggles do painel:** `vetting_m1_enforce` / `vetting_m2_enforce` (admin-only, via `engine_control`; env `VETTING_M{1,2}_ENFORCE`
é a chave-mestra). Flags: `VETTING_ENABLED`, `VETTING_M{1,2}_OBSERVE`, `VETTING_REVET_ENABLED/SEC(600)`,
`VETTING_DEEP_LIQUIDITY`, `VETTING_MAX_ROUNDTRIP_BPS(300)`, `VETTING_ROUNDTRIP_USD(1000)`.

**Verde (sweep final, RPC ON):** typecheck 0 · execution-utils 368 · liquidator 114 (fork) · mis-scanner 52 (fork) ·
frontend 39 · tsc 0 · contratos **intocados** (100% off-chain). Detalhe em `docs/TOKEN_VETTING.md`.

**Refinamento opcional documentado (NÃO iniciar sem OK):** Tier 1 = confirmação de lock **on-chain** pros tokens de maior
valor (ABI do locker via BaseScan + leitura via RPC multicall). A **Atena** vigia na mainnet o lock rico Tier 0
(lock vencendo / % caindo / locker suspeito) — anotado em `docs/ATENA_AGENT_DESIGN.md`.

---

## 🆕 SESSÃO 2026-06-30 — Tela Estratégias + pentest + pré-liq multi-DEX + design da Atena (tudo na `main`)

Sessão de observabilidade + higiene + visão. **4 merges na `main`**, sweep verde com RPC ligado a cada passo
(regra nova: **fork tests SEMPRE com RPC exportado → 0 SKIPPED**; e **re-alinhar a cada ~1M tokens** lendo
este CLAUDE.md + git log).

**1. Tela "Estratégias" (observabilidade candidatos × resultados):** nova tela no painel compara as 3
estratégias de lucro — **clássica × pré-liquidação Morpho × filler UniswapX** — mostrando CANDIDATOS (o que
cada uma lucraria, vale em DRY_RUN) × RESULTADOS (o que executou). Responde "quem dá mais lucro quando rodar".
Todo o dado viaja no **heartbeat agregado** (`StrategyStatsTracker` → `service_status.strategy_stats` jsonb),
**não infla `events`**, e o bot conhece a estratégia com precisão (resolve a ambiguidade filler-vs-arb). Sem
mudança de contrato. `StrategyStatsTracker` em execution-utils (janela rolante 24h) + alimentado no
`liquidationEdgeGate` (clássica+pré-liq) e `runFillerTick` (filler).

**2. Pentest da feature (4 frentes paralelas):** segredos / injeção / DoS-memória / regressão-de-trading.
**Zero bug crítico vivo.** 3 patches **defensivos** aplicados: (a) `dispatcher` isola `strategyTracker.executed()`
num try/catch próprio — observabilidade NUNCA pode virar uma tx confirmada em falha reportada + nonce
invalidado; (b) `/api/ingest` ganhou `sanitizeStrategyStats()` (allowlist + número finito + cap) na fronteira;
(c) `live.ts` com guarda de finito no merge (lixo do jsonb → 0, nunca NaN).

**3. Pré-liquidação multi-DEX (merge `claude/preliq-multidex`, "Achado 1" da revisão):** o calculator da pré-liq
passa a cotar via `bestSwapAcrossDexes` (UniV3/Aero/Slipstream single-hop) quando há `chainConfig` — o
multi-hop legado **não era executável single-hop pelo contrato → revertia**. Agora **estimativa == execução**
e captura a liquidez CL funda de Aero/Slipstream nos colaterais LSD (cbETH/wstETH/cbBTC) da pré-liq.

**4. 🦉 ATENA — design do agente de IA operacional (`docs/ATENA_AGENT_DESIGN.md`, doc-only):** conselheira
estratégica que **lê** o dado que o ZEUS já emite (ledger OIE/Prometheus/competidores) e pensa/zela/aprende.
**Autonomia graduada por consequência** (4 degraus: auto-ajuste+avisa → propõe+autoriza → aconselha+você-executa
→ pulso verde), **5 travas** (mão longe das chaves; auto-freio se os ajustes dela correlacionam com PnL pior →
ela congela a própria autonomia), triagem por domínio [INFRA]/[CÓDIGO]/[CAPITAL]/[COMPETIDOR]/[MERCADO]. Stack:
**Claude Agent SDK + Opus/Haiku + Telegram + Fly.io**, plugada no `ADAPTIVE_THRESHOLDS_ENABLED` que já dorme.
**Custo honesto: API ≠ Max** (conta de API separada, ~US$150-250/mês base). Rollout faseado 0→4; **Fase 4
(agir sozinha) só amadurece no DRY_RUN.** Ainda **sem código** — é design.

**Verde a cada merge (RPC ON):** typecheck 0 · execution-utils 359 · liquidator 114 (fork) · mis-scanner 52
(fork) · frontend 35 · **`forge test` 190** (0 fail, 1 skip intencional). **750 testes, 0 falha.**

**Branches mergeadas+limpas:** `strategy-observability`, `preliq-multidex`, `atena-agent-design`.

**5. 🛡️ Auditoria dos contratos (6 auditores paralelos, fork RPC) + v10 hardening:** zero bug crítico vivo;
espinha dorsal sólida (anti-hijack flashloan, reentrância, profit gates, fixes H/M antigos intactos). 2
inconsistências sistêmicas + higiene corrigidas (branch `claude/v10-hardening`):
- **Tema A** — `approvedRouter` whitelist (default-deny) em ZeusMorphoPreLiquidator + ZeusUniswapXFiller
  (tinham nascido sem a blindagem v9); `approvedComet` em ZeusLiquidator (caminho Compound) + zera approval
  do buyCollateral. **NÃO limita o bot** — whitelist é de routers/comets (infra fixa), não de tokens/pares.
- **Tema B** — `onlyOperator` unificado no modelo PERMISSIVO (owner||operador) nos 6: dono(=multisig só do
  Humberto) opera E administra; chave quente do servidor só opera. Conserta footgun de deploy.
- **Tema C** (decisão Humberto) — caps **~US$200k por token** setados no deploy em Base mainnet (8453);
  setter segue `onlyOwner` (multisig = a proteção, SEM timelock). Não é throttle: o sizer off-chain dimensiona
  pela liquidez ATÉ o teto. Tune via multisig.
- **Tema D** — liga `DexType.UniswapV4` no ArbExecutor (antes revertia); guarda anti-truncamento uint128 no
  UniswapV4Lib; eventos em setWeth/setUniV3SwapRouter; `rescueETH` em todos; `Killed_`→`BotKilled` (Moonwell).
- **Verde:** `forge test` **191** (0 fail, 1 skip, RPC ON, +deny test do comet) · typecheck 0 · TS 359/114/52 ·
  EIP-170 ok (ZeusLiquidator 22.502/24.576 — folga 2.074, **vigiar**).
- **Deploy v10 Base Sepolia (2026-06-30, owner=deployer=`0xE060…cBB4`, todos KILLED fail-safe):**
  BribeManager `0x7395111e3A5495396E4dca387Bc023731eB6E239` · ZeusLiquidator `0xc971101BC132C3814961D87E32F6744981f36957` ·
  ZeusArbExecutor `0xfbba12130f199C762e8A70d7a2815b634A8B13e0` · ZeusMoonwellLiquidator `0xCF19B41eC7BAb6A3FAF5a6ece6Aa394430b803da` ·
  ZeusMorphoPreLiquidator `0x5Ffc8a207D951EFbD54A6De6B01DE39C08fE31F9` · ZeusUniswapXFiller `0x9b2E5CC77004485eB5c87C69AE82F4E860D852AB`.
  Verificado via cast: owner ok, killed=true, approvedRouter(UniV3)=true nos 4, approvedComet/random=false (default-deny).
  **Pós-deploy (runbook testnet):** revive() + setOperator(bot). Na MAINNET os routers/caps/comets são TURNKEY
  (deploy aplica auto se deployer==owner) — só revive()+setOperator ficam manuais.
- **Deploy mainnet turnkey:** `_configureBaseMainnet` (chainid 8453) aprova **11 routers DEX da Base + caps
  $200k (USDC/WETH/cbBTC) + 2 Comets** nos 5 contratos. Fluxo de posse: deploya como EOA (turnkey dispara) →
  `FINAL_OWNER` env (multisig) recebe `transferOwnership` → multisig faz `acceptOwnership()` (Ownable2Step).
- **🛡️ RE-AUDITORIA do v10 (5 auditores paralelos, fork RPC, 2026-06-30):** **zero crítico/HIGH/MEDIUM.** HIGH
  (pré-liq/filler router) + LOW-2 (comet) ORIGINAIS resolvidos, sem regressão; anti-hijack/reentrância/fixes
  H-01/H-02/M-01/M-02 intactos; **16/16 endereços do deploy conferidos via cast** (símbolo/decimais/baseToken).
  2 ajustes finos aplicados: guarda uint128 do `minAmountOut` no V4Lib + fluxo de posse `FINAL_OWNER` no deploy.
  **Mainnet ainda exige 2 semanas testnet** (regra inviolável). EIP-170: ZeusLiquidator 22.502/24.576 (vigiar).

---

## 🆕 SESSÃO 2026-06-26 — Motor 1 (pré-liq) + Motor 2 (filler UniswapX + V4) COMPLETOS, mergeado na `main`

Maratona (~28 commits). **Os 2 motores ficaram 100% de CÓDIGO na `main`, testados.** Merge complexo resolvido
(a `main` tinha reimplementado o engine_control do Motor 1 em paralelo → adotei o da `main`, removi meus
duplicados, religuei pré-liq+wallet-pool no `liveExecutionEnabled` da `main`, preservando 100% do trabalho único).

**Motor 1 — Pré-liquidação Morpho (NOVO edge, complementar à liquidação clássica):**
- Contrato satélite `ZeusMorphoPreLiquidator.sol` (callback `onPreLiquidate`, dex-sourced, **sem flashloan/capital**,
  stable-only, whitelist default-deny + flag transiente). **Deployado+verified Base Sepolia**
  `0x5797E24C6eCb0fEb14fB39cbe11ff9B5b347E534`. 17 unit + 3 fork.
- Pipeline off-chain `apps/liquidator/src/protocols/morpho-preliq/` (math replica `preLiquidate`, factory/discovery/
  calculator/builder/simulator/runner). A "caça" é AUTOMÁTICA no discoveryTick (varre on-chain, não recebe ordem).
- **KILL_SWITCH real** (mainnet recusa subir se != false) + corrigido footgun `z.coerce.boolean("false")===true` → helper `boolEnv`.
- **Wallet-pool** (`packages/execution-utils/src/walletPool/` — COMPARTILHADO M1+M2 desde 2026-07-01): N EOAs de 1
  seed-mestre + breaker AGREGADO (nega no teto) + nonce-pool (blindado contra corrida em acquire paralelo) + funding
  planner + **orquestrador plugado no dispatch** (M1 + M2 paralelo). Cobre os 4 cuidados do Humberto. Acende com a chave-mestra.
- Gated OFF (`MORPHO_PRELIQ_ENABLED`, `WALLET_POOL_ENABLED`).

**Motor 2 — Filler UniswapX (pivô; recon deu viável-mas-disputado):**
- Recon A/B/C/D + margem medida na Dune (long-tail 20-120 bps, dex-sourced 80%). Doc `COMPETITOR_RECON_UNISWAPX.md`.
- Contrato satélite `ZeusUniswapXFiller.sol` (callback `reactorCallback`, dex-sourced sem capital). 17 unit + 2 fork.
- App `apps/mis-scanner/src/uniswapx/` (avaliador+builder+feed). Feed **validado contra a API REAL** (corrigiu:
  type→reactor, cosignerData.outputOverrides, exclusiveFiller). Obedece o toggle motor2.
- **Execução Uniswap V4 on-chain** (`DexType.UniswapV4=7` + `UniswapV4Lib.sol` via Universal Router + Permit2) —
  **PROVADA EM FORK** (WETH→USDC real = 1568 USDC, encoding V4_SWAP correto). bestQuote usa V4 quando ganha.

**Verde na `main`:** contratos **190/0** · execution-utils 355 (flake DuckDB corrigido c/ singleFork) · liquidator 93 ·
mis-scanner 47 · dex-adapters 8 (pin) · **typecheck monorepo 0**.

**⏳ POSICIONAMENTO PENDENTE (decisão Humberto):** código pronto na `main` MAS **não na MAINNET**. Falta: deploy
mainnet (M1 só Sepolia; M2 filler em nenhuma rede) + cadastrar mercados/reactors + DRY_RUN + virar a chave. **Próxima
sessão registrada:** fiar observabilidade dos motores novos (filler + pré-liq DRY_RUN) → Supabase → frontend (hoje o
filler só loga, a caça da pré-liq não reporta candidatos no painel).

## 🆕 SESSÃO 2026-06-25 (parte 3) — Painel: login MAZARI + branding + UX (tudo na `main`, deployado na Vercel)

Sessão focada no **ZEUS Command (frontend)**: autenticação real + identidade visual MAZARI + acabamento.
Tudo commitado, **pushed e deployado** (Vercel auto-deploy na `main`). Frontend: `tsc` limpo · `next build` OK ·
vitest **35/35** (8 testes novos de auth/invite).

**1. Login completo (Supabase Auth) + cadastro por indicação com aprovação do admin:**
- Painel inteiro atrás de **login obrigatório** (em produção). Sem Supabase (dev/local) → modo demo sem login.
- **Papéis:** membro aprovado **só VÊ**; **armar o bot = admin-only** em 2 níveis (UI esconde o toggle **+**
  `/api/control` valida `requireAdmin` no servidor via Bearer). Conta-raiz = `humbertodeassuncao@gmail.com`.
- **Cadastro por LINK DE INDICAÇÃO** (só o admin gera) → conta nasce `pending` → **admin aprova** no painel.
  **Sem verificação de e-mail** (aprovação humana é o portão; sem SMTP).
- Tabelas `profiles` + `invites` + `is_admin()` + RLS (leitura de events/service_status/wallet apertada p/
  `authenticated`; `engine_control` segue anon p/ o bot ler). Rotas: `/api/auth/signup`, `/api/admin/invite`,
  `/api/admin/approve`, `/api/control` (admin). Helpers `lib/authClient.ts` + `lib/authServer.ts`. Guia em
  `frontend/AUTH_SETUP.md`.
- **Supabase JÁ CONFIGURADO ao vivo** (via Management API): tabelas+RLS criadas, conta admin criada+approved.
  O Personal Access Token do Humberto foi **revogado por ele** após o setup (higiene).

**2. Identidade visual MAZARI / ZEUS:**
- **Logo oficial ZEUS FLASHLOAN** (lockup, fundo transparente) na tela de login + rodapé **"Tecnologia
  exclusiva do Grupo MAZARI CORP"**. `public/brand/mazari-logo.png`.
- **App icon** (tile navy + raio) → ícone da home no PWA (manifest 192/512 any+maskable) + apple-touch +
  ícone das notificações. **Favicon** (monograma circular) → aba + badge. `public/icons/zeus-*.png`.
  _Sem resize (ImageMagick ausente; o `convert` do Windows é utilitário de DISCO — NÃO usar); PNGs 1080²
  escalam nativamente._

**3. UX de abertura + acabamento:**
- **ZeusLoader** (spinner dual-ring, ~1KB, sem libs) em `components/ZeusLoader.tsx` + keyframes no globals.css
  (respeita `prefers-reduced-motion`). `app/loading.tsx` (splash da rota).
- **Splash de entrada por NO MÍNIMO 4s** (`MIN_SPLASH_MS`) em paralelo à checagem de sessão (não soma atraso).
- **Crossfade suave** splash → login (`FADE_MS=500`, `@keyframes zfadein`).
- **Botão "Sair"** na topbar (1 clique, volta pro login; só com sessão real).
- **Selo de MODO real** na topbar (substitui o "MAINNET" hardcoded): **DRY-RUN/TESTNET/ARMADO/LIVE** vindo do
  heartbeat (cor por estado) + chain real. Read-only.

**Esclarecimento importante (DRY_RUN):** DRY_RUN **não se liga por botão** — é o modo padrão do bot
(`ARB_MODE=dryrun`) quando se **sobe a VM**. O toggle do painel **arma execução REAL** (só efetivo em modo
mainnet); em dryrun é irrelevante (nunca envia). Ir pra mainnet = decisão de **deploy**, não botão. O selo de
modo deixa isso visível. Próximo passo combinado: **checklist de subida da VM (Fly.io)** pra ligar o dry-run.

**Pendências de operação (Humberto):** trocar a senha do admin (passou pelo chat); (opcional) setar as 3 chaves
VAPID na Vercel pra push no celular; reinstalar o PWA no celular pra pegar o ícone novo.

---

## 🆕 SESSÃO 2026-06-25 (parte 2) — Reuso cross-motor: gorjeta auto-ligável + paridade defensiva M2 + plano triangular (tudo na `main`)

Foco: aproveitar funções que já existiam em um motor pra reforçar o outro (reuso barato de `execution-utils`),
sem código novo de lógica. Três entregas, todas com testes + typecheck 13/13 verdes:

**1. Gorjeta competitiva AUTO-LIGÁVEL no Motor 2** (commit `20c2a2e`):
- A `calculateCompetitiveBribe` (teto de lucro — nunca prejuízo) foi wireada no `arbDispatcher` do M2,
  **desligada por padrão**. O ZEUS **auto-liga sozinho** quando detecta evidência REAL de perda por gás
  (falhas `gas_outbid` ≥ limiar na janela) e **avisa no painel** (banner verde na tela Inteligência).
- Novo helper puro `shouldAutoEnableCompetitiveBribe` + `bribeAutoState` mutável + detector periódico (5min)
  no `index.ts`. Heartbeat ganhou `competitiveBribeAutoEnabled`/`bribeAutoEnableReason`. Sem mudança de schema.
- Honesto: na Base (FCFS) o ganho é **modesto** (inclusão, não fura-fila); vira arma em chains de leilão.

**2. Paridade defensiva do Motor 2 com o Motor 1** (commit `57f5ebf`):
- O M2 (indo pro DRY_RUN mainnet) **não herdara** as defesas que o M1 já tinha, mesmo prontas no
  `execution-utils`. Ligadas (dormentes em DRY_RUN): **reorg awareness** (`FinalityTracker` +
  `OrphanRecoveryManager` + `TxStateMachine` + `ReorgAnalytics`, mesmo encadeamento `onReorg` do M1) +
  **auto-pause de saúde** (`AutoPauseManager` + `BlockStalenessCheck` + `ProcessCheck` — o health server
  do M2 antes era "vazio"; agora pausa de verdade + gate pré-simulação no dispatcher) + **latência**
  (`LatencyTracker` → heartbeat p50/p95). Tudo sob guard opcional → zero regressão. 4 testes novos.
- **Lacuna pequena restante:** `GasReserveTracker` ainda não ligado no M2 (M1 tem). Outras defesas do M1
  (dedup de posição, Chainlink staleness, PauseDetector) **não se aplicam** ao arb (são de lending).

**3. Arb TRIANGULAR — plano + gatilho no painel** (commit `d1bee82`):
- A detecção triangular (`findTriangularCycles`) segue **read-only** (loga + grava `arb_triangular_observed`;
  NÃO vai pro dispatch). Ligar o toggle do frontend **NÃO** executa triangular — o toggle só libera a arb de
  **2 pernas** (que tem pipeline completo). Triangular precisa do **caminho de execução** (cola off-chain).
- `docs/TRIANGULAR_EXECUTION_PLAN.md`: plano da cola que falta (builder calldata multi-hop + sizing + EV gate
  tri + dispatch atrás do MESMO gate). Contrato on-chain **já suporta multi-hop**. Recomendado sub-toggle
  `TRIANGULAR_EXECUTION_ENABLED` (default OFF) sob a chave-mestra remota (validar antes de escalar).
- Painel: banner verde na Home **"Lucro provado, hora de implementar a ligação da arb triangular"** — dispara
  quando o lucro líquido ACUMULADO do M2 (arb) ≥ $50 E ops ≥ 20, no modo AO VIVO (em DRY_RUN fica 0 → quieto).

**Estado honesto pós-sessão (M1 + M2):** maduros **como software** e agora no mesmo nível de defesa. Mas
**"falta só o DRY_RUN" é otimista**: (a) o DRY_RUN ainda não está rodando (falta VM Fly.io + `GENERIC_WEBHOOK_URL`
+ envs Vercel); (b) o DRY_RUN é um **PORTÃO** que precisa PROVAR o edge — e o edge do M1 na Base é fino
(só Morpho; resto capturado por OEV) e o do M2 é **não-provado**; (c) mesmo provando, mainnet exige deploy
mainnet (hoje só Sepolia) + owner=multisig + operador separado + re-audit do v9 + 2 semanas testnet. Próximo
passo combinado: montar o **checklist de subida do DRY_RUN**.

---

## 🆕 SESSÃO 2026-06-24 — Painel real ponta-a-ponta + prontidão mainnet Motor 1/2 + validação ABI on-chain (tudo na `main`)

**Painel (ZEUS Command) — dado REAL fim-a-fim:**
- Cobertura de dados Fases 1/2/2b + insights (Fase 3): KPIs 7d/30d/projeção, barras 14d, PnL realizado×esperado, breakdown motor/protocolo, carteira+gás, relatórios, **saúde** (componentes/cooldowns/kill-switch/latência), **inteligência** (bribe P50/P75/P95, competidores, edge pairs, post-mortem, calibração, won/lost), **saldo 30d** (`wallet_snapshots`), **resiliência de reorg/órfã**. Detalhes em `docs/FRONTEND_DATA_COVERAGE.md`.
- **Toggle DEMO/LIVE** (mock × real). **Veredito de bribe dinâmico** (nosso lance vs p50/p75/p95, com mensagem de auto-ajuste). **Responsividade mobile** (topbar quebra em 2 linhas; auditado via Playwright em 351–390px → 0 overflow).
- Supabase: novas colunas jsonb em `service_status` (health/competitors/edge_pairs/cooldowns/kill_switch/latency/reorgs) + tabela `wallet_snapshots` + seed `engine_control(motor1)`.

**Motor 1 — prontidão MAINNET (mudanças de contrato = v9, AINDA NÃO deployado):**
- **Whitelist on-chain de routers** (`approvedRouter` + `setApprovedRouter` onlyOwner + check default-deny no `_executeSwaps`) nos 3 contratos. `Deploy.s.sol` aprova UniV3; demais routers via runbook.
- **Stale-check** estendido a **Morpho** (re-read fresh da position) + **Moonwell** (`getAccountLiquidity`), antes só Aave/Compound.
- **OrphanRecoveryManager + TxStateMachine** ligados no dispatch (re-submete tx órfã pós-reorg; dormente em DRY_RUN).
- Runbook `docs/MAINNET_READINESS_MOTOR1.md`.

**Toggle remoto de execução do Motor 1** (igual Motor 2): painel → `/api/control` → `engine_control(motor1)` → liquidator faz poll (15s) → gate "armado-mas-travado" no dispatcher (só `true` exato libera o envio). `fetchEngineControlEnabled` promovido pra `@zeus-evm/execution-utils` (compartilhado; mis-scanner re-exporta).

**Bribe competitor-aware com TETO DE LUCRO** (opt-in, `COMPETITIVE_BRIBE_ENABLED=false` default): auto-ajusta o priority fee pra ganhar a corrida, **limitado pelo lucro da oportunidade (nunca prejuízo)**; painel avisa o auto-ajuste. `calculateCompetitiveBribe` + `BribeTracker` em execution-utils.

**Validação ABI/contratos on-chain (Alchemy archive, FORK TESTS no CI — não script descartável):**
- **Motor 1**: liquidação provada on-chain → Aave (+lucro end-to-end via `MotorsProfit`), Morpho Blue, Compound III, Moonwell. NOVOS forks: `ZeusMoonwellLiquidator.fork` (liquidateBorrow), `ZeusCompoundLiquidator.fork` (absorb), `ZeusMorphoLiquidator.fork` (liquidate → revert `"position is healthy"` = **edge Morpho fechado**). Cast Sepolia: contratos respondem (seletores v8 ok); **v9 NÃO deployado** (`approvedRouter` reverte); **Moonwell `isKilled()=true`**.
- **Motor 2**: quoters off-chain validados (`dexQuotes.fork`: UniV3 1582 / Slipstream 1572 / BaseSwap 1333 USDC + Aero reserves) + flashloan **Aave/Morpho/Balancer** no arb (`ZeusArbExecutor.fork`) + execução de swap dos 4 DEX (+lucro, `ZeusArbExecutorDex.fork` 4/4).
- **`forge test` FULL: 147 passed / 0 failed** (1 skip unit intencional). Os fork tests provam **ABI/wiring/segurança**, não lucro (round-trips revertem) — exceto Aave/Dex que provam lucro end-to-end.

**✅ Redeploy v9 Base Sepolia FEITO (2026-06-25)** — inclui o swap multi-DEX/Slipstream + whitelist + stale-check + OrphanRecovery. Endereços:
- BribeManager `0x060469e0Cd4C477C6ABdCbAedB18d656EBB3dC2C` · ZeusLiquidator `0x6c0726ED372797Bc2aa1e41b7c9E80963835b9bc` · ZeusArbExecutor `0x2c3BDa4ce824e0BB464924C2977c3bf9Ad8f6f1E` · ZeusMoonwellLiquidator `0x9aE63562D625f0A3a2475C0B91445d5Bae97a447`.
- Owner=deployer `0xE060…cBB4`. Os 3 executores: `revive()` + `setOperator(0xE060…cBB4)` + UniV3 router no whitelist (cast confirma `approvedRouter(0x0)=false` em vez de reverter = v9 on-chain). **Ainda NÃO mainnet.**

**🔜 Falta (operacional, do Humberto):**
- **DRY_RUN mainnet ~2 semanas** (subir VM Fly.io + `GENERIC_WEBHOOK_URL` no `.env` do bot) — onde o lucro se prova com dado real.
- (Mainnet, futuro: owner=multisig + operador separado; aprovar os demais routers DEX no whitelist.)
- Branches `claude/motor1-multidex-*` mergeadas + apagadas (higiene).

## 🆕 SESSÃO 2026-06-23 — DEX Motor 2 + toggle + cola do painel (tudo na `main`)

**Mergeado + corrigido (commits `fcfc7be`→`f57222d`):**
- **Expansão de DEX do Motor 2:** Slipstream (Aerodrome CL) + UniV2 genérico (forks) + forks UniV3.
  **Adapter `PancakeV3Lib` + `DexType.PancakeV3=6`** (struct `exactInputSingle` COM deadline).
  Achado verificado on-chain: **Sushi V3 na Base também precisa de deadline** → `routerStyle='pancakeV3'`.
- **DexType unificado** (era triplicado): fonte única em `shared-types` + re-export + **pin test**.
- **Toggle remoto "armado-mas-travado"** (Motor 2): painel→`/api/control`→Supabase `engine_control`→bot poll→gate. Fail-safe. `/api/control` POST fail-closed em prod.
- **Endereços de venue verificados on-chain** (Alchemy archive): vivos = BaseSwap/AlienBase/SwapBased/Pancake-v2/Sushi-v2 + Pancake V3 + Sushi V3 + Slipstream. **Removidos** dackieswap-v2 (router morto) e rocketswap (sem par curado).
- **RPC: Alchemy é PRIMÁRIO** (dRPC free descartado — não forka archive). `BASE_RPC_ARCHIVE` + `pnpm contracts:test:fork` plug-and-play.
- **CI:** fix do `forge install` (forge 1.x removeu `--no-commit`) + pin de libs + job `contracts-fork` (trap de endereços). 3 jobs verdes. **Falta setar o secret `BASE_RPC_ARCHIVE` no GitHub** pra ativar o trap.
- **Redeploy Base Sepolia v8** (com os adapters): BribeManager `0xe0B6…4795` · ZeusLiquidator `0x8E76…193D` · ZeusArbExecutor `0x0156…ab4A` · Moonwell `0x3A34…3dA3`. Liquidator+ArbExecutor com `revive()` + `setOperator(0xE060…cBB4)`.
- **Cola do painel (eventos bot→painel):** Supabase criado (projeto `kwmhuokedfmlvntovjtw`, schema.sql rodado). `genericWebhookSink` manda `x-zeus-secret`; **mis-scanner liga o sink + emite `zeus.heartbeat`** (30s, direto, não infla DuckDB). Novo `HeartbeatEvent`.

**🔜 Falta (próxima sessão):**
- **Vercel:** setar 4 envs (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ZEUS_WEBHOOK_SECRET) + redeploy → painel sai do demo.
- **Bot `.env`:** preencher `GENERIC_WEBHOOK_URL` = `<URL do painel Vercel>/api/ingest` (falta a URL).
- **Moonwell:** `revive()` + `setOperator()` (se usar Motor 1 Moonwell — ficou com kill switch ativo).
- **Subir a VM na Fly.io** + secrets dela; depois **2 semanas DRY_RUN** antes de cogitar mainnet.
- Mainnet (futuro): owner=multisig + operador separado (no testnet ficou owner==operador).

## 🗺️ Estado atual (snapshot 2026-06-15)

### ✅ Pronto

**Camada smart contract (v8 — split por EIP-170):**
- Antigo `ZeusExecutor` monolítico **dividido em 4 contratos**: `ZeusArbExecutor` (arb + flashloan arb +
  flashloan backrun, multi-hop N steps = triangular, flashloan 3 fontes Aave/Morpho/Balancer) +
  `ZeusLiquidator` (Aave/Compound/Morpho + variantes WithBribe) + `ZeusMoonwellLiquidator` + `BribeManager`
- Security Audit Pass 1+2 + fixes (H-01, H-02, M-01, M-02)
- Deployado e verified em 3 chains **testnet** Sepolia (Base/Arb/OP). **Ainda NÃO em mainnet.**
- **78/79 testes unit Foundry** (1 skip) + suíte fork verde (inclui `MotorsProfit.fork.t.sol`)

**Camada off-chain (3 motores + intelligence):**

*Liquidator (Motor 1):* pipeline completo com gates pre-dispatch + stale check pre-submit.
Cobertura **Aave V3 + Compound III + Morpho Blue + Seamless (fork Aave) + Moonwell** nas 3 chains.
Inclui os 6 gaps críticos (pnlTracker/failureTracker/positionDedup/gasReserveTracker/gasOracle/eventBus +
staleCheck) — hoje consolidados em `@zeus-evm/execution-utils`.

*MIS scanner (Motor 2):* virou **motor de execução cross-DEX** (`arbDispatcher` + `arbOpportunity` + config zod).
Varredura de ineficiências (multicall + derivação de colaterais até 60 pares + flash sizing + Trader Joe LB),
ranqueia por persistência + **detecção triangular** (grafo de tokens + `findTriangularCycles`, read-only por ora).
**Execução DESLIGADA por default** (`ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun` → só grava `mis_observed`).
Travas: circuit breakers (MAX_TRADE_ETH / MIN_ARB_PROFIT_USD / slippage) validados na config zod; `EXECUTOR_PRIVATE_KEY`
exclusiva; **simula (eth_call) + EV gate ANTES de disparar**; re-cota fresco no dispatch; **flashloan-only / atômico**
(falha = só gás). Espelha toda a camada de inteligência (EventBus, PnlReconciler, CompetitorResolver, market-bribe,
auto-calibração).

*Backrun engine (Motor 3):* backrun pós-whale; EV gate competitor-aware (via nível de gas war) + bribe +
relays; grava no ledger.
> ⚠️ **BLOQUEADO EM PROD:** a tubulação está pronta, mas o feed de mempool (`subscribeWhaleSwaps`) é
> **placeholder** — não assina `alchemy_pendingTransactions`, então nunca emite `whale.swap_detected`
> em produção (só via smoke test). Base não tem mempool público; precisa Flashblocks WS / Alchemy
> Growth+. **Motor 3 não dispara até resolver isso.** Detalhes em [docs/LOOSE_WIRES.md](./docs/LOOSE_WIRES.md).

*Discovery scraper:* varredura dinâmica GeckoTerminal → `auto-targets.json` + token safety GoPlus.
O detector consome via `getTargetPairsForChain`.

**Camada OIE — Opportunity Intelligence Engine (entregue 2026-06-15, grande novidade):**
- **Etapa A — scoring:** Opportunity/Protocol/Pool/Token Score + ledger **DuckDB**
  (fix: `timestamp` BIGINT, antes estourava como INT32)
- **Etapa B — EV gates nos motores:** backrun competitor-aware (gas war) + liquidator **ciente de OEV**
  (aplica "OEV haircut" por protocolo e **prioriza Morpho**)
- **Etapa C — thresholds adaptativos:** FEITO, **opt-in** (`ADAPTIVE_THRESHOLDS_ENABLED=false` default → só loga o que faria)
- **Etapa D — Grafana:** parcial/quase — `DimensionMetricsExporter` (DuckDB→Prometheus) + 3 dashboards prontos (meta era 8)
- **OIE completa:** todos os sinais (market-bribe, perfis de competidor, reconciliação de PnL, falhas
  categorizadas, sybil, dedup, latência) caem no ledger DuckDB + Prometheus + painéis Grafana; market-bribe alimenta o BribeCalculator
- **DRY_RUN ledger:** detector + MIS gravam observações no DuckDB (`arb_observed` / `mis_observed`)
- Helpers: `resolveIntelligenceDbPath` / `buildObservationEvent` / `queryTopOpportunityPairs` /
  `attachAndRankPairs` (unificação cross-motor via ATTACH — DuckDB single-writer)
- **Deploy Fly.io:** `Dockerfile` raiz + `deploy/fly/*.toml` com volume persistente

**Achado estratégico (refs):** liquidação na Base se fechando por OEV capture (Aave SVR ~85%,
Moonwell MEV tax ~99%). **Morpho Blue ABERTO = único edge real** → liquidator prioriza Morpho.
Nota competitiva honesta: **~7,5 como software, ~4,5 como competidor** hoje.

- **Total** (pós-2026-06-24): **`forge test` 147 passed / 0 failed** (78 unit + fork suite ampliada — novos forks Moonwell/Compound/Morpho-liquidation + dexQuotes + arb Morpho/Balancer) · **~430 testes TS** (vitest; execution-utils
  **336/336**) · **typecheck 13/13** · 7 apps · 6 packages

### 🟡 Em andamento (próxima sessão)
- **2 semanas DRY_RUN mainnet** — observação + calibração (ledger DuckDB coletando, lucro real US$ 0)
- **OIE Etapa D** — parcial/quase: `DimensionMetricsExporter` (bridge DuckDB→Prometheus) + 3 dashboards
  (operations/performance/rankings) prontos; meta original era 8 dashboards
- **Detector ranking na descoberta** (radar passivo, baixa prioridade)

**Detalhes da adoção OIE em [docs/OIE_PROGRESS.md](./docs/OIE_PROGRESS.md).**

### ✅ Concluído recente (era "em andamento")
- **Sprint 3 Morpho pipeline TS** — FEITO (discovery + calculator + builder + simulator)
- **Motor 2 (MIS)** — virou **motor de execução cross-DEX** (`arbDispatcher`/`arbOpportunity`/config zod),
  **execução OFF por default** (`ARB_EXECUTION_ENABLED=false` / `ARB_MODE=dryrun` → continua gravando `mis_observed`);
  + **detecção triangular** (`findTriangularCycles`, read-only por ora) + inteligência espelhada (EventBus/PnL/competitor/market-bribe)
- **Motor 3 (Backrun)** — fechou as 2 últimas pontas (PnlAggregator + CalibrationDriftTracker + post-mortem
  CompetitorResolver/BlockPositionTracker); **continua BLOQUEADO em prod** (feed de mempool é placeholder; ver acima)
- **OIE Etapa C (thresholds adaptativos)** — FEITO, **opt-in** (`ADAPTIVE_THRESHOLDS_ENABLED=false` default → só loga o que faria)
- **Fios soltos remediados (auditoria):** RPC fallback (dRPC→Alchemy via viem), discovery Aave/Seamless on-chain
  SEMPRE (TheGraph só acelerador), qualidade de dado (gás nunca mais $0, mis-scanner com zod, priority fee real,
  Moonwell `optionalAddress`, INT32 round), classes "órfãs" ligadas (dormentes em DRY_RUN). Deferidos (infra):
  mempool do Motor 3 + `deploy/fly/backrun-engine.toml`
- _Seletor de flashloan 0% (Morpho/Balancer) agora ligado no **liquidator + arb (Motor 2)**; o backrun ainda
  força Aave 0,05% (semi-ligado, sem impacto hoje porque Motor 3 está morto). Regra `approvedDexAdapters`
  documentada não tem enforcement on-chain. Ver_ [docs/LOOSE_WIRES.md](./docs/LOOSE_WIRES.md)._
- **Bribe Compound/Morpho** — variantes WithBribe voltaram no contrato v8 (split); ABI off-chain + builders
  ligados (opt-in `BRIBE_ENABLED=false` default)
- **Health endpoint HTTP** — FEITO (`execution-utils/health`) + Prometheus exporter; backrun passou a expor `/metrics`

### 📅 Roadmap
- **Arb-engine (Motor 2)** — motor de execução JÁ existe (OFF por default); calibrar no DRY_RUN e ligar quando edge provado
- **Execução triangular** — detecção já roda read-only; próximo passo é o caminho de execução
- **Fase 7**: Deploy contratos em Base mainnet + 4 semanas observação capital pequeno
- **Avalanche expansion**: Aave V3 only, +500-800 borrowers
- **Audit externo**: Trail of Bits / Spearbit quando capital > $50k

**Tese de 3 motores descorrelacionados:** ZEUS fatura em qualquer mercado (#1 crash, #2 volume, #3 volatilidade).

**Detalhes completos em [TODO.md](./TODO.md).**

### 🔑 Decisões já tomadas
- Provider RPC: **Alchemy** primário (archive no free) + fallback a definir (dRPC free descartado em 2026-06-23 — não forka archive)
- Owner = **carteira testnet dedicada** `0xE060821b253ec9dad4BDe139c5661Bc07A6AcBB4` (testnet-only)
- Contratos ainda na **SEPOLIA (testnet)** — **NÃO mainnet**. Lucro real **US$ 0** (provado em fork).
  - **Base Sepolia v8 (redeploy 2026-06-23, com DexType.PancakeV3 + adapters DEX):**
    BribeManager `0xe0B6A6840d1f011F27Ec63eb3390D0d7E0904795` · ZeusLiquidator `0x8E769a56F0f3fA7e7410fE5955D94E9dE458193D` ·
    ZeusArbExecutor `0x0156Aa6729891103Cc22b1e14c5E1e5338E6ab4A` · ZeusMoonwellLiquidator `0x3A34EcDD1A9a53d5799fF0f4cB479FF2963F3dA3`.
    Owner = deployer `0xE060…cBB4`. Liquidator + ArbExecutor já com `revive()` (isKilled=false); falta `setOperator(<bot>)` + revive do Moonwell.
  - **ZeusMorphoPreLiquidator (pré-liquidação Morpho) — Base Sepolia 2026-06-26:**
    `0x5797E24C6eCb0fEb14fB39cbe11ff9B5b347E534` (verified · owner=operator=`0xE060…cBB4` ·
    revive() OK, isKilled=false · maxTradeWei 0.01 ETH). Cadastro de mercados
    (`setApprovedPreLiquidation`) + DRY_RUN ficam pra **MAIN** (Sepolia não tem markets reais).
    No redeploy mainnet: novo endereço + `PRE_LIQUIDATOR_ADDRESS` no `.env`.
  - _Histórico v6 (pré-split, contrato único): Base Sepolia `0xe38298B4d242d0D1C45696a96c4C588926Cf1139`,
    Arb/OP Sepolia `0xe48473D75805886Ac4162B1304EAB6b8F93C5faa`. Anteriores arquivados: Base v2
    `0xe53cb8c...`, Arb/OP v1 `0xd7e8fde...`._

### ⏸️ Aguardando decisão do Humberto
- **Ligar execução do arb (Motor 2)** — motor pronto e OFF por default; aguarda edge provado no DRY_RUN/ledger
- Multisig provider — antes de Fase 7
- Capital inicial concreto — antes de Fase 7
- Audit provider — antes de audit externo

---

## 🔑 Decisões já tomadas

- ✅ Chain inicial: **Base** (Coinbase L2)
- ✅ 3 motores: Liquidations (M1) + MIS scanner (M2) + Backrun (M3); arb Cross-DEX/Triangular compartilha o executor
- ✅ Stack: TypeScript + viem + Foundry (não ethers, não Hardhat)
- ✅ Flashloan: multi-fonte 0% — Morpho + Balancer primário, Aave V3 0.05% fallback
- ✅ Custódia: self-custody com circuit breakers
- ✅ Owner: multisig Safe Wallet em prod
- ✅ Sem proxy upgradeable
- ✅ Repo: `github.com/Opresida/zeus-evm` (push quando MVP estiver pronto)
- ✅ Capital inicial: **decidir depois** (código abstrai)
- ✅ Audit interno antes de mainnet, audit externo antes de capital alto

---

## 🤖 Padrão de trabalho

- **Mapear o que existe ANTES de criar do zero** — sempre buscar reutilizar adapters
- **Em decisão importante, perguntar** via `AskUserQuestion` com tradeoffs
- **Atualizar `TODO.md` ao concluir/iniciar fase**
- **`pnpm typecheck && forge test` antes de "concluído"**
- **Em dúvida sobre math (slippage, fee calc)**, perguntar ao Humberto
- **Commits descritivos em PT-BR**, Conventional Commits opcional

---

## 🔧 Comandos úteis

```bash
# Monorepo
pnpm install
pnpm typecheck
pnpm build
pnpm -r --filter @zeus-evm/detector dev  # subir 1 app

# Foundry (de dentro de contracts/)
forge build
forge test -vvv
forge test --fuzz-runs 100000
forge coverage --report lcov
forge fmt
forge install <repo>
forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast

# Deploy
pnpm --filter @zeus-evm/detector run dev  # detector em watch mode
```

### RTK (Rust Token Killer) — economia de tokens

Humberto usa `rtk` como prefixo padrão:
- `rtk pnpm install` → 90% menos output
- `rtk forge build` (se RTK suportar) ou prefixar comandos verbose
- `rtk git status`, `rtk grep`, `rtk ls`

Se RTK não estiver instalado nesta máquina, comandos normais.

---

## 🧠 Como expandir conhecimento da IA

Eu, Claude, tenho limites em áreas como:
- 🟡 Aerodrome deep mechanics (ve(3,3))
- 🟡 Compound V3 e Morpho APIs específicas
- 🟡 MEV em Base (landscape único)
- 🔴 Gas optimization extremo (Yul/assembly nível Seaport)

**Pra expandir:** Humberto pode salvar MDs em `docs/refs/`. Quando eu trabalhar em área relevante, leio antes de codar. Ver [CONTRACTS.md](./CONTRACTS.md#knowledge-limits-da-ia-claude) seção "Knowledge Limits" pra detalhes.

---

## 📂 Documentação relacionada

| Arquivo | Quando consultar |
|---|---|
| `README.md` | Setup inicial, comandos, roadmap resumido |
| `CONTEXT.md` | Regras, princípios de risco, voz |
| `PROJECT_CONTEXT.md` | Status atual, decisões abertas, time |
| `ARCHITECTURE.md` | Fluxos de dados, estrutura de pastas, schema |
| `TODO.md` | O que falta por fase |
| `CONTRACTS.md` | Spec dos smart contracts + audit pipeline + limites IA |
| `CLAUDE.md` | Este arquivo — contexto portátil |
| `frontend/HANDOFF.md` | **ZEUS Command (frontend Next.js/Vercel)** — intenção, ponte de dados, o que falta, e contexto pro Claude no Antigravity continuar |

**docs/ (status + planos):**

| Arquivo | Quando consultar |
|---|---|
| `docs/OIE_PROGRESS.md` | Adoção da camada OIE (Etapas A→D) + decisões |
| `docs/FIRST_FLIGHT.md` | Primeiro voo / checklist de DRY_RUN |
| `docs/INFRA_EVOLUTION.md` | Evolução de infra |
| `docs/MOTOR3_REFIT.md` | Refit do motor 3 (backrun) |
| `docs/NO_EDGE_TOKENS.md` | Tokens sem edge (blacklist/filtro) |
| `docs/ATENA_AGENT_DESIGN.md` | 🦉 Design da Atena (agente de IA operacional: autonomia graduada, 5 travas, custos API≠Max, rollout 0→4) |
| `docs/TOKEN_VETTING.md` | 🛂 Porteiro de tokens (vetting): política por motor, matriz de flags/toggles, observar→enforce, estado das 7 etapas |
| `docs/PAINEL_FIOS_SOLTOS.md` | 🔌 Auditoria de fios soltos + prontidão do painel (Saúde/Inteligência): o que foi ligado, cosméticos restantes (7–11), próximo = Parte 3 Automações |
| `docs/AUTOMACOES.md` | 🤖 Chave-mestra de execução + Automações "vivas" (Parte 3, 14 itens): estado das levas, #5-via-Dune, regras (observe-first, nunca auto-liga) |

**docs/refs/ (conhecimento externo — outro agente cuida, não editar aqui):**

| Arquivo | Quando consultar |
|---|---|
| `docs/refs/competitive-landscape.md` | Landscape competitivo MEV/liquidações na Base |
| `docs/refs/cross-dex-arb-status.md` | Status do arb cross-DEX |
| `docs/refs/engine-strategy.md` | Estratégia dos 3 motores |
| `docs/refs/fly-deploy.md` | Guia de deploy Fly.io |
| `docs/refs/infra-costs.md` | Custos de infra |
| `docs/refs/morpho-profit-projection.md` | Projeção de lucro Morpho (edge real) |

Quando voltar ao projeto em outra sessão/máquina, ler os 7 arquivos-raiz + `docs/OIE_PROGRESS.md` é suficiente.
