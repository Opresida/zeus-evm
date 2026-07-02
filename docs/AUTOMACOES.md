# 🤖 Chave-mestra de execução + Automações "vivas" (Parte 3)

O bot se **auto-ajusta dentro de travas**, **avisa no painel** e é **reversível**. Registro do que foi feito
(2026-07-01), o que falta e as regras. **100% off-chain.**

## ⚖️ Regras invioláveis de TODA automação
- **Claude NUNCA auto-liga execução** — quem liga trade é o humano (toggle do painel).
- Sempre **piso/teto + histerese** (não fica nervosa) · sempre **avisa no painel** · sempre **reversível** (env/toggle).
- **Observe-first:** por padrão, a automação MOSTRA "o que faria" (DRY_RUN) antes de injetar; só aplica quando ligada.
- Usa dado que o bot **já mede** (não inventa sinal). **Mock do painel espelha o AO VIVO.**

## 🔑 Chave-mestra de execução (o toggle acende o "pacote de combate")
Ao ligar "enviar TX" de um motor (`liveExecutionEnabled` via `engine_control`), acende JUNTO o pacote:

| Pacote de combate | Motor | Como acopla |
|---|---|---|
| **Adaptive thresholds** (injeta o piso de EV no gate) | M1 + M2 | `liveExecutionEnabled || env.ADAPTIVE_THRESHOLDS_ENABLED` (inline nas deps) |
| **Bribe competitivo** | M1 + M2 | `liveExecutionEnabled || env.COMPETITIVE_BRIBE_ENABLED` (inline nas deps) |
| **Slippage por-DEX (#5)** (gate calibrado do Dune) | M1 + M2 | `liveExecutionEnabled || env.SLIPPAGE_PER_DEX_ENABLED` — M2 inline no gate; M1 via `applyCombatBundle` (muta `state.env`, os 4 calculators leem fresco) |
| **Cooldown adaptativo (#4)** (backoff por falhas) | M1 | `liveExecutionEnabled || env.ADAPTIVE_COOLDOWN_ENABLED` — via `failureTracker.setAdaptiveCooldown()` (tracker é construído 1×) |
| **Wallet-pool** (N carteiras paralelas) | M1 + M2 | `liveExecutionEnabled || env.WALLET_POOL_ENABLED` (precisa da seed) |

- **Env vira override force-on**; default segue o toggle. **Vetting/porteiro fica INDEPENDENTE** (decisão do Humberto).
- **🟢 CANÁRIO do painel (2026-07-01, decisão do Humberto):** as bolinhas viram DIAGNÓSTICO. Features de **AVALIAÇÃO**
  (Piso de EV observe + Slippage por-DEX) acendem **VERDE já no DRY_RUN** (rodam sem execução) — se não acender no boot
  do DRY_RUN, é BUG. Features de **EXECUÇÃO** (Bribe competitivo + Wallet-pool) ficam **CINZA no DRY_RUN** e só acendem
  quando o TX liga — se acenderem no dryrun OU não acenderem ao ligar o TX, é BUG. Por isso `SLIPPAGE_PER_DEX_ENABLED`
  virou **default TRUE** (ativo já na avaliação; kill-switch = setar false) e bribe/pool ganharam gate `armed` (mode != dryrun).
- **Mecanismo (M1):** `applyCombatBundle(live)` no toggle poll (`apps/liquidator/src/index.ts`) captura os defaults do `.env`
  1× e re-aplica `live || default` em cada flag (restaura o valor original ao desligar). M2 já é inline no scan/heartbeat.
- **ISOLADO com motivo (decisão honesta, NÃO acoplado):** `BRIBE_ENABLED` — bribe **flat-%-do-lucro cego**; na Base (FCFS)
  é **superado pelo bribe competitivo** (que já é do pacote e só paga quando perde corrida). Acoplar os dois = **double-bribe
  queimando lucro**. Fica como **override manual** pra chains de leilão. (Cai na exceção "uma ou outra pode ficar isolada".)
- Painel (Configurações) mostra o pacote via `combatBundle` no heartbeat — **agora dos DOIS motores** (M1 emite
  o `combatMirror` via objeto por-ref, igual o `vettingEnforce`; `live.ts` funde em `combatBundle` (M2) +
  `combatBundleM1`; Settings.tsx renderiza um card por motor). Antes só o M2 aparecia → não dava pra ver o que o M1 acendia.

## 👛 Wallet-pool — N frentes paralelas (relocado p/ execution-utils)
- Módulo compartilhado em `packages/execution-utils/src/walletPool/` (era `apps/liquidator/src/walletPool/`).
- **Motor 2 ganhou dispatch PARALELO:** cada oportunidade numa carteira/nonce independente (`Promise.all`) — 7 arbs
  simultâneas deixam de serializar. Acionado pela chave-mestra.
- **✅ Motor 1 acoplado à chave-mestra (2026-07-01):** o pool era construído só com `WALLET_POOL_ENABLED=true` (flag
  esquecível — o footgun da Regra 1). Agora **constrói quando a SEED existe** (`WALLET_POOL_MNEMONIC` + não-dryrun),
  igual o M2; a ativação segue o toggle (dispatch da pré-liq é gated a montante). ⚠️ **Só passe a seed com as carteiras
  ABASTECIDAS.** **Escopo (2026-07-01, decisão do Humberto):** o pool do M1 está ligado na **liquidação clássica
  (Aave/Compound/Morpho/Moonwell) E na pré-liquidação** — os 5 runners passam `senderPool` + `poolExposureWei: 1n`
  (breaker agregado compartilhado limita a concorrência total). Sem seed → tudo cai na carteira main (funciona, só serializa).
- **Nonce:** o `NoncePool` semeia via API (`getTransactionCount 'pending'`) **1× por carteira**, depois incrementa
  **local** (economiza RPC). O M2 usa o **nonce explícito** do pool (igual M1). Sem pool → viem auto-nonce via API.
- **🐛 Fix crítico de corrida** no `orchestrator.acquire`: reserva o slot de ocupação ANTES do await + re-checa
  `requiresSync` DEPOIS → 2 acquire paralelos nunca pegam a mesma carteira/nonce. Provado (size 2 → distintas; size 1 → 9,10).
- **Custo:** derivar as 22 carteiras = ZERO; abastecer com gás = ETH real (passo de mainnet). Broadcast real = validação testnet.

## 📋 Estado das 14 automações
**Leva 1 (feita):**
- **#1 Piso de EV auto-calibrável OBSERVÁVEL** — emite `calibration.applied` nos 2 modos (flag `applied`); card "o que faria".
- **#2 RPC degradado visível** — destrava o `warn` do `BlockStalenessCheck` → componente tri-estado (verde/amarelo/vermelho).
- **#3 Escalada de gás do competidor** — p95 do market-bribe +50% E ≥2 competidores → banner (Inteligência).

**Leva 2 (feita):**
- **#4 Cooldown adaptativo** — backoff = base × (1+cooldowns), teto 30min, histerese (−1/sucesso); observe-first (`ADAPTIVE_COOLDOWN_ENABLED`).
- **#6 Edge sumindo** — soma dos top-5 scores do `mis.ranking()` cai ≥30% em ~1h → banner.
- **#5 slippage por DEX — ADIADO / via DUNE (ver abaixo).**

**Leva 3 (feita — 2026-07-02, observe-first):** trackers em `execution-utils/src/intelligence/`, card na aba Inteligência.
- **#9 Calibração de gás** (`GasCalibrationTracker`) — amostra o custo AO VIVO (baseFee fresco × gas típico × ethUsd) na
  janela 24h (p50/p95), compara com o `GAS_COST_USD_ESTIMATE` estático e mostra "ajustaria p/ $X". Injeta só com
  `GAS_CALIBRATION_ENABLED=true` (observe-first). Feed no `discoveryTick` do M1 (cache por bloco → ~0 RPC extra).
- **#8 Pool depth** (`PoolDepthTracker`) — usa o tamanho ótimo que o pool absorve (do `optimizeFlashLoan`, ZERO RPC extra)
  como proxy de profundidade; alerta em queda ≥30% na janela 1h. Feed no scan do M2. Só avisa.
- **#7 Quarentena de token** (`TokenQuarantineTracker`) — acumula reverts por token/par na janela 24h; ≥`QUARANTINE_FAILURE_THRESHOLD`
  (5) → "quarentenaria" (histerese: sucesso alivia). Feed no evento `failure.recorded` (novo campo `collateralSymbol`) do M1.
  Ação real gated por `QUARANTINE_ENABLED` (default false).

**Leva 4 (feita — 2026-07-02, observe-first):**
- **#10 Throttle de varredura** + **#11 Revet dinâmico** (`AdaptiveIntervalAdvisor`) — recomendam acelerar/desacelerar a
  varredura (economia de RPC quando parado) e o re-vet (mais frequente quando o universo muda muito), com histerese.
  Feed no heartbeat do M2 (sinal = nº de pares com edge / nº de tokens rejeitados). Só mostram "reduziria pra Xs".
- **#12 Wallet-pool rebalance** (`computeWalletRebalance`, reusa `planGasTopUps`/`planGasSweeps`) — lê o saldo das EOAs do
  pool e mostra "reabasteceria X ETH" (não move nada). Só quando o pool EXISTE (mainnet/armado; omitido em dryrun, honesto).
  Feed no `discoveryTick` do M1 (throttle 5min). Config `WALLET_POOL_MIN_GAS_ETH`/`WALLET_POOL_TARGET_GAS_ETH`.

**Leva 5 (feita — 2026-07-02, observe-first):**
- **#13 Saúde do flashloan** (`FlashHealthTracker`) — registra a fonte escolhida a cada seleção (Morpho/Balancer 0% ×
  Aave 0,05% pago) na janela 6h; avisa quando >25% cai no fallback PAGO (fontes 0% sem liquidez pro tamanho). Feed nos
  4 sites de `selectFlashSource` do M1 (roda em dryrun — é probe read). Só observa.
- **#14 Latência de relay/dispatch** (`RelayLatencyAdvisor`) — reusa o `LatencyTracker` que o bot já tem; guarda a
  baseline (melhor p95) e avisa quando degrada ≥2×. Feed no heartbeat do M2. Sem amostra em dryrun (sem dispatch) → honesto.

**✅ TODAS AS 14 AUTOMAÇÕES FEITAS.** Trackers em `packages/execution-utils/src/intelligence/`, card único "Automações
vivas" na aba Inteligência (fundido dos 2 motores via `live_automations`). Nenhuma auto-liga execução; tudo mostra "o
que faria" e é gated por flag. Contratos INTOCADOS.

## 🎯 #5 slippage por DEX — via DUNE (ideia do Humberto, aprovada)
**Bloqueio:** o `slippageRealTracker` só decodifica slippage REAL — no DRY_RUN não há swap pra medir. Calibrar o
`MAX_SLIPPAGE_BPS` por-DEX exigiria execução na mainnet.

**Desbloqueio (Dune):** o Dune tem o histórico de swaps reais da Base de TODO mundo. Recorta-se um pedaço e calibra-se
em cima do dado real, **sem esperar mainnet**:
1. Query Dune: impacto de preço por **DEX × faixa de tamanho** ($1k/$5k/$10k/$50k) na Base, janela 30-90d → p50/p95.
2. Exporta → tabela `slippage_by_dex` (p95 por DEX).
3. O gate de slippage deixa de ser global e passa a ser **por DEX** (seed do Dune); o adaptativo refina com dado próprio.
4. Painel mostra a tabela ("UniV3 15bps · Aero 60bps · fonte: Dune 60d").
5. **Validação cruzada:** quando a execução real rodar, compara o slippage MEDIDO vs o previsto pelo Dune.

Tooling: `dune/slippage_by_dex.sql` + `dune/dune.mjs` (cliente API, sem jq). Chave em `.env` (`DUNE_API_KEY`).
Dune MCP também configurado (`~/.claude.json`) — disponível a partir da próxima sessão.

**✅ VALIDADO 2026-07-01 (query pública `7860473`, 66 linhas, Base 30d):** a hipótese se confirmou — slippage varia
MUITO por DEX. p95 (bps) medido: `uniswap-3` ~90-127 · `uniswap-4` ~70-98 · `aerodrome-slipstream` ~64-107 ·
`aerodrome-1` (volátil) ~147-255 · `pancakeswap-3` ~75-88. **Nosso 50 bps GLOBAL está apertado demais** pra quase
todos → rejeita trades bons. **Ressalva honesta:** a métrica é um PROXY (desvio da mediana horária) que inclui
ruído/MEV — ótima pra comparar DEXes e dar um chute inicial, refinar depois (impacto por reservas do pool).
**✅ WIRED NOS 2 MOTORES (observe-first, default global):** helper compartilhado `effectiveMaxSlippageBps` em
execution-utils — Motor 2 (arb) usa 2 pernas (`routeSlippageBps`); Motor 1 (liquidação) usa 1 perna (venda do
colateral) nos 4 calculators (aave/compound/morpho/pré-liq). Flag `SLIPPAGE_PER_DEX_ENABLED` (default false = sem
regressão). **✅ ACOPLADO À CHAVE-MESTRA (2026-07-01):** o toggle de execução acende o gate por-DEX junto nos 2 motores
(`liveExecutionEnabled || env.SLIPPAGE_PER_DEX_ENABLED`) — não fica mais dormente atrás de flag esquecido. **Próximo:**
refinar a métrica (impacto por reservas) + threading do notional real por-calculator. 1º caso do feed Dune.

> **Sem contrato tocado.** Tudo é gate/observabilidade de software. Relatório completo (PDF) em `C:\Users\user\ZEUS_Automacoes_Parte3.pdf`.
