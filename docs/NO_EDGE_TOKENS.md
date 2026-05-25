# Tokens sem Edge — Lista negra do detector

Tokens **investigados** mas **excluídos** da lista de pares-alvo. Documento vivo — atualizar quando descobrir novo motivo de exclusão ou quando situação on-chain mudar (relisting permitido).

**Princípio:** se um token aparece aqui, **NÃO incluir** em `target-pairs.ts` sem antes revalidar via `apps/backtest/src/discover-pairs.ts` E aprovação explícita.

---

## 📋 Tabela consolidada

| Token | Endereço | Categoria | Motivo descartado | Data | Pode revisitar? |
|---|---|---|---|---|---|
| **cbETH** | `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` | LST | Pegged a ETH + pools pequenos ($70k UniV3, $130k Aero) → edge < 0,05% capturado por bots LST em ms | 2026-05-23 | 🟡 Só se TVL explodir ou se desplugar do peg |
| **wstETH** | `0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452` | LST | Idem cbETH — pegged via yield acumulado, pools razoáveis ($236k+$715k) mas arb LST é hipercompetitivo | 2026-05-23 | 🟡 Só se houver evento de despegging Lido |
| **DEGEN** | `0x4ed4e862860bed51a9570b96d89af5e1b0efefed` | Memecoin | Liquidez concentrada **só em UniV3** ($516k fee3000). Aerodrome só tem pool volatile=$28k (abaixo do cutoff $50k). **Sem cross-DEX possível.** | 2026-05-23 | 🟢 Sim, se aparecer pool Aerodrome ≥$50k |
| **BRETT** | `0x532f27101965dd16442e59d40670faf5ebb142e4` | Memecoin | Liquidez concentrada **só em UniV3** (fee3000=$58k, fee10000=$1,285M). Aerodrome zerado. | 2026-05-23 | 🟢 Sim, se aparecer pool Aerodrome ≥$50k |
| **TOSHI** | `0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4` | Memecoin | Liquidez **só UniV3** (fee10000=$1M). Aerodrome zerado. | 2026-05-23 | 🟢 Sim, se aparecer pool Aerodrome ≥$50k |
| **HIGHER** | `0x0578d8a44db98b23bf096a382e016e29a5ce0ffe` | Memecoin médio | Pools abaixo do cutoff em ambos DEXs (UniV3 fee10000=$31k, Aero volatile=$2k) | 2026-05-23 | 🟡 Só se TVL crescer significativamente |
| **AIXBT** | `0x121ed556713ed543c3c14dcbcd9238d12e380a5f` | AI agent | **Nenhum pool encontrado** em UniV3 ou Aerodrome. Esse endereço pode ser de um AIXBT secundário/fake. | 2026-05-23 | 🔴 Investigar se endereço correto é outro |
| **VIRTUAL/USDC** | par específico | AI agent | Token VIRTUAL **tem** pool Aerodrome (em par com WETH), mas par específico com USDC só existe no UniV3 fee3000=$436k | 2026-05-23 | 🟡 Token OK — só par específico problemático |

---

## 🧠 Por que esses tokens não têm edge cross-DEX

### Caso 1: Liquidez monogâmica (DEGEN, BRETT, TOSHI)

Esses memecoins **nascem no UniV3** (rotina dos criadores) e a liquidez nunca migra significativamente pro Aerodrome. Razões:
- Devs lançam em UniV3 porque é mais simples (sem governance, sem gauges, sem ve(3,3))
- Holders ficam na primeira pool que aparece
- Sem incentivo concreto (emissões AERO) pra criar pool no Aerodrome → não migra

**Implicação técnica:** sem ter pool em **ambos** os DEXs, cross-DEX arb é impossível por definição.

### Caso 2: Pegged tokens (cbETH, wstETH)

LSTs são pegged ao ETH via mecanismo on-chain (cbETH cresce via exchange rate, wstETH via wrapping). Quando há gap entre LST e ETH:
- Bots LST-arb especializados (Stakewise, Lido, etc) capturam em < 1 bloco
- Spread máximo histórico: 0,05-0,2% em momentos de stress
- Pra capturar 0,05% precisaria gas < 0,001% do trade, latência < 200ms → fora do nosso nicho

### Caso 3: TVL insuficiente (HIGHER, AIXBT)

Pools com TVL < $50k:
- Slippage absurda em trades > $500
- Volume baixo = poucas oportunidades por dia
- Risco de honeypot / rug / fake token

---

## 🔄 Quando revisitar

Re-rodar `apps/backtest/src/discover-pairs.ts` em duas situações:

1. **Trimestralmente** — landscape de Base muda rápido, pools migram
2. **Após eventos específicos**:
   - Anúncio de listing/migração de token pra Aerodrome
   - Evento de despegging em LST
   - Crash de mercado (LSTs podem desplugar)

Comando:
```bash
BASE_RPC_HTTP="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY" \
  NODE_ENV=production \
  pnpm --filter @zeus-evm/backtest exec tsx src/discover-pairs.ts
```

Output salvo em `apps/backtest/runs/discover-*.json`.

---

## 🟢 Tokens APROVADOS atuais (em `packages/chain-config/src/target-pairs.ts`)

Para referência:

| Par | Categoria | Edge esperada |
|---|---|---|
| **AERO/USDC** | DEX token | 🟢 Alta — desbalance UniV3 $75k vs Aero $26M |
| **AERO/WETH** | DEX token | 🟢 Alta — mesma dinâmica em par WETH |
| **VIRTUAL/WETH** | AI agent | 🟡 Média — fragmentação UniV3 entre 3 fee tiers |

---

## 🚨 Lição crítica: Mid-price ≠ Execution price (2026-05-26)

Durante exploração de Sprint 2 (LRT depeg arbitrage), descobrimos:

**Quote individual (1 unidade) mostra spread inexistente na realidade:**
- cbETH/WETH Base: spread 4,1% no mid-price → 0,45% LOSS em 0.1 ETH, 45% LOSS em 25 ETH
- wstETH/WETH Arbitrum fee100 vs fee3000: spread 32% no mid-price → 91% LOSS em 10 ETH

**Causa**: pools "secundários" (fee tiers menos usados) têm liquidez tão baixa que
qualquer trade real esgota o pool e move o preço drasticamente.

**Regra de ouro**: NUNCA usar quote de 1 unidade como sinal de oportunidade.
Sempre simular com **tamanho realista** (>= $1k) antes de assumir edge real.

Implicação:
- Cross-DEX arb baseado em mid-price spread = estratégia quebrada
- Vale APENAS pra pools profundos E balanceados (raro em L2s 2026)
- Pra LRTs, melhor estratégia = "wait-for-event" (eventos de stress reais)

## 📝 Histórico de mudanças

| Data | Mudança |
|---|---|
| 2026-05-23 | Criação inicial. Trilha 2 (Radar Longtail) — exclui LSTs + memecoins sem pool Aerodrome |
| 2026-05-26 | Lição mid-price ≠ execution: cross-DEX LRT confirmado SEM edge (cbETH Base + wstETH Arbitrum testados) |
