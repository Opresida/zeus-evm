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
│   ├── execution-utils/    # PACOTE GRANDE — trackers (pnl/failure/dedup/gas) + gasOracle + eventBus/events
│   │                       #   + intelligence DuckDB (TimeseriesStore + EventIngester + observation)
│   │                       #   + pnlReconciler/attribution + failureCollector + senderRegistry
│   │                       #   + scoring (chainProfitability/opportunity/dimension/dimensionStatsQuery)
│   │                       #   + prometheus + health + MarketInefficiencyScanner + bribeSlippageFloor + Tracer
│   └── shared-types/
├── docs/                   # OIE_PROGRESS + FIRST_FLIGHT + INFRA_EVOLUTION + MOTOR3_REFIT + NO_EDGE_TOKENS + grafana/
│   └── refs/               # MDs externos pra expandir conhecimento da IA
├── frontend/               # ZEUS Command — painel Next.js (Vercel) que espelha o backend.
│                           # App STANDALONE (package.json próprio, FORA do pnpm workspace;
│                           # instalar com `pnpm install --ignore-workspace`). Ponte de dados:
│                           # bot genericWebhookSink → /api/ingest → Supabase Realtime → painel
│                           # + Web Push/Email. LER frontend/HANDOFF.md ANTES de mexer.
└── deploy/fly/             # Dockerfile raiz + detector/liquidator/mis-scanner.toml (volume persistente)
```

---

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
