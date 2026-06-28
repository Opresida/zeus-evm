# ATENA — Agente de IA operacional do ZEUS (design)

> Conselheira estratégica do ZEUS. "ZEUS executa; **Atena** pensa, zela e aprende."
> Lê todos os dados do bot, detecta bugs e oportunidades, vigia concorrentes, recomenda melhorias de
> infra/código com base em dado real, e se comunica com o Presidente (Humberto) — proativa, curiosa,
> com autonomia **graduada por consequência**. Doc de design — sem código ainda.

---

## 1. Princípio central — autonomia graduada por consequência

A Atena **nasce operacional** (percebe, raciocina, detecta, aconselha desde o dia 1 — o dado e as funções
já estão escritos). O que **amadurece durante o DRY_RUN** é só a permissão de **agir sozinha**. Regra de
ouro: **autonomia ∝ inverso da consequência; ação que REDUZ risco tem mais rédea que a que AUMENTA.**

### A escada de 4 degraus

| Degrau | O que é | Atena... | Exemplos |
|---|---|---|---|
| **A — Auto-ajuste + avisa** | knobs seguros e **reversíveis**, dentro de bandas pré-aprovadas | **age e reporta** ("fiz X porque Y") | recuar a mão no risco quando o mercado vira; pausar um mercado problemático |
| **B — Propõe + autoriza** | config/backend que muda comportamento ou risco | **diagnostica + plano + porquê → espera OK** | "reverts demais, causa = Z, aqui o plano, me autoriza?"; "**aumentar** a mão, temos margem" |
| **C — Aconselha + você executa** | o que ela não pode fazer (dinheiro externo) | **pesquisa + custo + link + recomendação** | "precisamos de MEMPOOL, essa é a melhor, custos e link"; "RPC em 10%, comprar mais" |
| **D — Pulso de status** | tudo bem | **dá o "verde" calmo** | "Presidente, operação plena: 0 falhas, latência ok, caixa 38 dias" |

O degrau **D** resolve "quando está bem, eu sei que está bem" — o silêncio é ambíguo, então a Atena manda
pulso verde periódico. Fora de hora = algo mudou.

### Triagem por domínio (você sabe ONDE correr)
Toda mensagem é etiquetada: **[INFRA]** · **[CÓDIGO]** · **[CAPITAL]** · **[COMPETIDOR]** · **[MERCADO]**.
Em 1 segundo você sabe se corre pro Fly.io, pro dev, ou pra carteira.

---

## 2. As 5 travas (o que torna a autonomia confiável)

1. **Bandas pré-aprovadas (degrau A):** só mexe um parâmetro dentro de uma faixa que você definiu. Fora da
   faixa → vira degrau B.
2. **Mão longe das chaves:** leitura do dado, **nunca** as chaves de execução. Capital/MAX_TRADE = sempre seu OK.
3. **Anti-thrashing:** rate-limit (não ajusta o mesmo knob repetidamente).
4. **Auto-freio da Atena:** ela monitora o **próprio histórico** (diário + reconciliação de PnL). Se os
   ajustes dela correlacionam com PnL pior → **congela a própria autonomia e te escala.** Ela se demite se
   estiver atrapalhando.
5. **Log auditável** de tudo + **kill-switch** dela + **teto de orçamento de tokens**.

**Limite honesto:** **config** ela aplica (após OK, via engine_control/adaptive-thresholds que já existem);
**código** ela **propõe** (diagnóstico/PR) e um humano/Antigravity implementa. Nenhum LLM dá push de código
num bot de dinheiro.

---

## 3. Arquitetura — 4 camadas (sobre o que já existe)

O ZEUS já emite dado estruturado rico → a Atena **senta em cima**, não recria.

**Sentidos (ferramentas de leitura):**
- `consultaLedger(sql)` → DuckDB/OIE (PnL, falhas, observações, scoring, perfis de competidor).
- `lêMétricas()` → Prometheus (latência, gás, saúde).
- `lêCompetidores()` → `CompetitorResolver`/`senderRegistry` + fingerprint on-chain.
- `lêChain(rpc)` → posições, txs de concorrentes, oráculos (recon ao vivo).
- `pesquisaWeb()` → notícias, contratos de concorrentes, opções de infra (server tool `web_search`).
- `lêProjeto()` → docs + código (entende o ZEUS inteiro).

**Cérebro (loop):** agendado (revisão diária, pós-crash) **+** por gatilho (pico de falhas, drift, mudança de
competidor). Proativo, não só reativo.

**Mãos (ações, sob a régua):**
- `rodaBacktest(params)` → dirige o `apps/backtest` (experimento seguro).
- `propõeAjuste(diff, evidência)` → proposta pra revisão (degrau B).
- `recomendaInfra(evidência)` → memo lastreado em dado real (degrau C).
- `aplicaConfig(...)` → só pós-OK, via engine_control/adaptive-thresholds existentes (degrau A/B).
- `comunica(canal, msg)` → Telegram + painel.

**Memória / aprendizado:** um **diário** — toda recomendação logada com a previsão; depois o resultado real;
a Atena mede o próprio acerto e calibra. Plugado na reconciliação de PnL + drift de calibração que já temos.

**Gancho que já está dormindo:** o `ADAPTIVE_THRESHOLDS_ENABLED` (opt-in, hoje só loga o que faria) → a
Atena vira o cérebro dele: decide o ajuste, propõe, você aprova, o caminho adaptativo (que existe) aplica.

---

## 4. Stack recomendada

- **SDK:** **Claude Agent SDK + Anthropic SDK (TypeScript)** — bate com o stack do ZEUS; loop de agente +
  tool use + tool runner prontos. As fontes de dado viram **ferramentas/MCP**.
- **Modelos (mix por custo):**
  - **`claude-opus-4-8`** — raciocínio profundo (análises, propostas, recon de competidor).
  - **`claude-haiku-4-5`** — vigília barata e frequente.
- **Prompt caching** do contexto do projeto (docs/schema/mapa de código) → leituras a ~0.1× do preço (grande
  economia).
- **Comunicação:** **Telegram** (push + autorização por botão inline pros degraus B/C) + **Painel** (pulso
  verde do degrau D + log de decisões/auditoria).
- **Hospedagem:** worker leve no **Fly.io** (já temos), agendado (cron) + acordado por evento.
- **Identidade/voz:** chama de **"Presidente"**, PT-BR, sempre **evidência + recomendação + caminho**.

> Por que não "OpenClaw"/"Hermes": "OpenClaw" não é framework estabelecido (não apostar a inteligência do bot
> nisso); "Hermes" é família de **modelos** (Nous), não framework. O Claude Agent SDK é maduro e fala TS.

---

## 5. 💰 Custos (o que se preparar pra pagar)

### ⚠️ O ponto crítico: API ≠ Max
O plano **Claude Max NÃO cobre a Atena.** Max = uso **interativo** (Claude.ai, Claude Code na sua máquina).
A Atena é um **programa que chama a API da Anthropic** → cobrado **por token, numa conta de API separada**
(plataforma de desenvolvedor), com billing próprio. **Você precisa de uma conta de API com crédito.**

### Preço dos modelos (por 1M de tokens)
| Modelo | Input | Output |
|---|---|---|
| `claude-opus-4-8` | US$ 5,00 | US$ 25,00 |
| `claude-sonnet-4-6` | US$ 3,00 | US$ 15,00 |
| `claude-haiku-4-5` | US$ 1,00 | US$ 5,00 |
| **Cache** | leitura ~0,1× do input · escrita 1,25× (5min) / 2× (1h) | |

### Como a Atena gasta (design enxuto)
- **Gate determinístico grátis:** a maioria dos "ticks" de vigília é checagem de limiar em **código** (zero
  LLM). O LLM (Haiku) só roda em **anomalia** ou no **digest periódico**.
- **Opus** só nas análises profundas: digest diário + investigações disparadas + propostas + chat sob demanda.
- **Caching** do contexto do projeto → cada chamada relê o contexto a 0,1×.

### Estimativa mensal (ilustrativa — depende de cadência/gatilhos/contexto)
| Cenário | Opus/dia | Haiku/dia | Web search | **~Custo/mês (API)** |
|---|---|---|---|---|
| **Leve** (início, poucos gatilhos) | ~3-5 | ~10-20 | pouco | **~US$ 50-100** |
| **Base** (operação normal) | ~10-15 | ~30-50 | moderado | **~US$ 150-250** |
| **Pesado** (crash/volátil, muito recon) | ~25-40 | ~80+ | bastante | **~US$ 300-500** |

**Mais:**
- **Fly.io** (worker da Atena): ~US$ 5-10/mês (já temos a conta).
- **Telegram:** grátis.
- **Web search (server tool):** custo variável por busca — **confirmar o preço atual** antes de ligar pesquisa
  intensiva (some à estimativa acima nos cenários com muito recon).

### As alavancas que controlam o custo
1. **Gate determinístico antes do LLM** (corta 90% das chamadas de vigília).
2. **Haiku pra vigília, Opus só pro profundo** (5× mais barato no input).
3. **Prompt caching** do contexto (leituras a 0,1×).
4. **Teto de orçamento de tokens** (trava dura — a Atena para ao bater o limite).
5. **Frequência ajustável** (vigília a cada 10-15 min, não a cada minuto).

> **Resumo honesto:** prepare-se pra **~US$ 150-250/mês** numa operação normal (mais picos em meses voláteis),
> numa **conta de API separada do seu Max**. É barato perto de um humano vigiando 24/7 — mas não é "grátis
> pelo Max".

---

## 6. Rollout faseado (sábio = validar cada passo)

| Fase | O que liga | Autonomia |
|---|---|---|
| **0 — Analista** | relatório diário (ledger + competidores) no Telegram/painel | só leitura |
| **1 — Vigia proativo** | alertas com raciocínio em gatilhos (falhas/drift/competidor) + caça-bug + recon | advisory |
| **2 — Cientista** | roda backtests pra testar hipóteses, reporta | experimentos seguros |
| **3 — Conselheiro** | propõe mudanças de config (diff) pra sua aprovação | propõe, você aplica |
| **4 — (só se provado)** | auto-ajuste nos knobs seguros/reversíveis, atrás das bandas + teto agregado + timelock + kill-switch | degrau A escopado |

A Atena nasce nas Fases 0-3 **operacional** (percebe, detecta, aconselha). A Fase 4 (degrau A — agir sozinha)
**amadurece durante o DRY_RUN**: ela assiste os ajustes + resultados reais e ganha a rédea quando prova que
acerta. Mesmo timeline — sem atraso.

---

## 7. O que a Atena entrega desde o dia 1 (read+raciocínio, zero risco)
- **[CÓDIGO] Caça-bug:** correlaciona reverts/falhas/traces → "esse padrão é anormal, a causa é X". Detecta +
  diagnostica; o fix em código é humano.
- **[COMPETIDOR] Recon contínuo:** traça txs dos concorrentes, lê/decompila contratos, detecta tática nova/
  função copiável → "o bot X começou a fazer Y, vale copiar isto". Automatiza o recon que hoje é manual.
- **[INFRA] Vigia de recursos:** RPC/gás/caixa acabando → aconselha comprar antes de quebrar.
- **[CAPITAL] Sentinela de risco:** margem sobrando/faltando → propõe subir/baixar a mão (subir = pede OK).
- **[D] Pulso verde:** "operação plena" — pra você dormir tranquilo.

---

## 8. Próximos passos
1. Abrir conta de **API da Anthropic** + setar teto de orçamento (preparar o custo da §5).
2. Construir a **Fase 0** (analista read-only) — prova a tubulação de dados + utilidade, custo mínimo.
3. Ligar **Telegram** (push + botões) e o **pulso verde** no painel.
4. Avançar 1→3 conforme a confiança; **Fase 4 só depois do DRY_RUN** provar a calibração.

**Branch:** `claude/atena-agent-design` (este doc). Implementação em branches próprias por fase.
