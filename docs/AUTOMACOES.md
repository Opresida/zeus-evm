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
| **Adaptive thresholds** (injeta o piso de EV no gate) | M1 + M2 | `liveExecutionEnabled || env.ADAPTIVE_THRESHOLDS_ENABLED` |
| **Bribe competitivo** | M1 + M2 | `liveExecutionEnabled || env.COMPETITIVE_BRIBE_ENABLED` |
| **Wallet-pool** (N carteiras paralelas) | M1 + M2 | `liveExecutionEnabled || env.WALLET_POOL_ENABLED` (precisa da seed) |

- **Env vira override force-on**; default segue o toggle. **Vetting/porteiro fica INDEPENDENTE** (decisão do Humberto).
- **Deferido:** `BRIBE_ENABLED` (bribe-%-profit, Base-modesto, fundo no pipeline).
- Painel (Configurações) mostra o pacote via `combatBundle` no heartbeat do M2 (transparência).

## 👛 Wallet-pool — N frentes paralelas (relocado p/ execution-utils)
- Módulo compartilhado em `packages/execution-utils/src/walletPool/` (era `apps/liquidator/src/walletPool/`).
- **Motor 2 ganhou dispatch PARALELO:** cada oportunidade numa carteira/nonce independente (`Promise.all`) — 7 arbs
  simultâneas deixam de serializar. Acionado pela chave-mestra.
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

**Falta:** Leva 3 (#7 quarentena token · #8 pool depth · #9 calibração de gás) · Leva 4 (#10 throttle · #11 revet
dinâmico · #12 wallet-pool rebalance) · Leva 5 (#13 flashloan health · #14 relay latency).

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

Custo: SQL rodado **manual na UI do Dune (grátis)** + tabela embutida no config = zero custo pra validar a hipótese.
Cron via Dune API = tier pago (decisão de mainnet). É o **1º caso de uso do feed de inteligência do Dune** (recon de
competidores, calibração, backtest — tira carga histórica do RPC).

> **Sem contrato tocado.** Tudo é gate/observabilidade de software. Relatório completo (PDF) em `C:\Users\user\ZEUS_Automacoes_Parte3.pdf`.
