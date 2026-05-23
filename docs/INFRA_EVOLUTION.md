# Plano de Evolução de Infra — ZEUS EVM

Caminho gradual de infraestrutura conforme o bot escala. Cada estágio tem **trigger claro** pra promover (não migrar antes do tempo, não atrasar quando justificado).

**Princípio:** infra é alavanca de latência + uptime, não milagre. Edge da estratégia vem primeiro; infra otimiza captura.

---

## 📊 Estágios

### 🌱 Estágio 0 — Atual (até Fase 5b validar)

**Custo:** ~$0/mês
**Latência total:** 300-800ms

| Componente | Provider | Detalhes |
|---|---|---|
| RPC primário | **dRPC free** | 210M CU/mês, 100 RPS, rate-limited após bursts |
| RPC fallback | **Alchemy free** | 30M CU/mês, 25 RPS, archive incluído |
| WSS (newHeads) | Alchemy free | 5 connections, com auto-reconnect |
| Compute | Local (Windows + WSL) | Sem servidor dedicado |
| Notificações | Pino logs apenas | Sem Discord/Telegram ainda |

**Bom pra:** desenvolvimento, fork tests, backtest, observação Sepolia.

**Limites:** burst limit do dRPC (vide bug do discover-pairs.ts), rate limit Alchemy free, latência variável (compute local + rede residencial brasileira).

**Trigger pra promover → Estágio 1:** Trilha 1 (liquidations) deployada e capturando 1+ liquidação real em mainnet capital pequeno (Fase 7).

---

### 🌿 Estágio 1 — Primeiro deploy production

**Custo:** ~$60-100/mês
**Latência total:** 150-300ms

| Componente | Provider | Detalhes |
|---|---|---|
| RPC primário | **dRPC Growth ($10/mês)** | Sem burst limit, 500 RPS |
| RPC fallback | **Alchemy Growth ($49/mês)** | 300+ RPS, archive ilimitado, debug_traceCall |
| WSS dedicado | Alchemy Growth | Smart Websockets (auto-reconnect server-side) |
| Compute | **Fly.io VM** (~$5-10/mês) | App `nrt` ou `iad` (próximo do Coinbase) |
| Notificações | Discord webhook | Alertas críticos (kill, loss, errors) |

**Bom pra:** primeiros meses de mainnet com capital pequeno (0.5-5 ETH).

**Trigger pra promover → Estágio 2:** $10k+ em profit acumulado OU capital mainnet > $50k OU competição de liquidações ficou agressiva.

---

### 🌳 Estágio 2 — Scale moderado

**Custo:** ~$300-600/mês
**Latência total:** 80-150ms

| Componente | Provider | Detalhes |
|---|---|---|
| RPC primário | **QuickNode Build ($49/mês)** | Trace API + archive incluído, 50 RPS |
| RPC secundário | **dRPC Growth ($10/mês)** | Backup |
| RPC mempool | **Alchemy Mempool Subscriptions ($199/mês)** | pending tx em real-time |
| WSS multi-region | QuickNode + Alchemy | Redundância |
| Compute | **Fly.io dedicated** (~$50-100/mês) | 2-4 vCPU, 4-8GB RAM, região US-East (IAD) |
| Database | Neon Postgres (Hobby ~$0) | Histórico de trades + positions monitoradas |
| Notificações | Discord + Telegram + Tenderly | Multi-canal |

**Bom pra:** capital mainnet $50k-500k. Liquidations + cross-DEX backrunning ativos.

**Trigger pra promover → Estágio 3:** competindo diretamente com top 10 bots em Base OU profit > $20k/mês consistente.

---

### 🌲 Estágio 3 — Premium

**Custo:** ~$1.500-3.000/mês
**Latência total:** 30-80ms

| Componente | Provider | Detalhes |
|---|---|---|
| Node primário | **QuickNode Dedicated Node ($999/mês)** | RPC privado, archive, trace, 500+ RPS sustentável |
| Node mempool | **Blocknative ($499/mês)** | Mempool premium com fluxo direto |
| Compute | **Fly.io performance dedicated** (~$200/mês) | 8 vCPU, 16GB, IAD/NRT |
| Geo redundancy | 2-3 regiões | Failover automático |
| Database | Neon Postgres Pro ($69/mês) | Backup contínuo + replicas |
| Monitoring | Grafana Cloud + Tenderly Pro | Dashboards real-time + alerts |
| Security | Forta Network + bug bounty Immunefi ($5-10k pool) | Detecção de exploits |

**Bom pra:** capital > $500k. Bot top 20 em Base.

**Trigger pra promover → Estágio 4:** profit > $100k/mês OU concorrência exige co-location física.

---

### 🌴 Estágio 4 — Top-tier (longo prazo, especulativo)

**Custo:** ~$5k-15k/mês
**Latência total:** 10-30ms

| Componente | Provider | Detalhes |
|---|---|---|
| Node | **Reth self-hosted bare-metal** | VPS dedicado próximo ao Coinbase AWS (us-east-1) |
| Mempool premium | **Direct relayer agreement** | Acordo direto com Coinbase sequencer (se possível) |
| Bundling | **MEV-Boost relay próprio** | Se Base adotar (não tem ainda em 2026) |
| Compute | Bare-metal dedicated | 16+ vCPU, NVMe, 10Gbps network |
| Geo | Co-location AWS us-east-1 | Latência <5ms ao sequencer |
| Team | DevOps full-time | Mantém infra 24/7 |

**Bom pra:** virar bot top 5 em Base. Capital $10M+.

---

## 🎯 Onde estamos vs onde queremos chegar

```
Hoje (Estágio 0) ←── você está aqui
   │
   │ Trigger: Fase 7 (mainnet capital pequeno funcionando)
   ▼
Estágio 1 (~$60-100/mês)
   │
   │ Trigger: $10k+ profit acumulado
   ▼
Estágio 2 (~$300-600/mês)
   │
   │ Trigger: profit > $20k/mês
   ▼
Estágio 3 (~$1.5-3k/mês)
   │
   │ Trigger: profit > $100k/mês
   ▼
Estágio 4 (~$5-15k/mês)
```

**Meta declarada do Humberto:** $1/min = $43.200/mês = atinge Estágio 3 quando estiver maduro.

---

## 🔍 Verdades inconvenientes sobre latência em Base

1. **Base sequencer é centralizado (Coinbase)** — não há MEV-Boost competitivo como Ethereum L1. Vantagem: menos competição visível. Desvantagem: bots com acordo privado com sequencer têm latência negativa (sim, negativa — sabem da tx antes).

2. **Block time de 2s** — toda otimização de latência vai dar diminishing returns abaixo de ~200ms, porque nada acontece on-chain antes do próximo bloco de qualquer jeito.

3. **WebSocket de RPC público tem jitter** — mesmo Alchemy/QuickNode WSS tem variação de 50-500ms entre eventos. Só self-hosted Reth ou private relay resolve.

4. **Localização física importa pra cross-DEX (us, ms)** mas é **irrelevante pra liquidações (s)**. Por isso nossa Trilha 1 (liquidations) não exige Estágio 3+ pra começar funcionando.

5. **Custo de Fly.io NRT (Tóquio) vs IAD (US East)**: o sequencer Base provavelmente está em AWS us-east-1. Fly.io IAD é melhor escolha.

---

## 📝 Histórico de mudanças

| Data | Mudança |
|---|---|
| 2026-05-23 | Criação inicial. 5 estágios mapeados (0 → 4). Estamos em Estágio 0. |
