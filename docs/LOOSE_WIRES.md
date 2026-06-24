# ZEUS EVM — Fios Soltos (auditoria + remediação)

> Documento mestre da auditoria global de "pontas soltas" (2026-06-18). Consolida o que está
> sólido, o que é fio solto, e o plano de remediação faseado. Honestidade > otimismo: a tese de
> "3 motores descorrelacionados" hoje, na prática, **se reduz a 1 motor parcialmente estrangulado**.

> **Atualização 2026-06-24 — Prontidão MAINNET do Motor 1 (FECHADO):**
> - ✅ **OrphanRecoveryManager** (R5) ligado no dispatch (re-submete tx órfã pós-reorg; dormente em DRY_RUN).
> - ✅ **approvedDexAdapters** agora é **whitelist on-chain** (`approvedRouter` + `setApprovedRouter` nos 3
>   contratos; default-deny) — não é mais só doc.
> - ✅ **Stale-check** estendido a **Morpho** (re-read fresh) e **Moonwell** (`getAccountLiquidity`), antes só Aave/Compound.
> - Operacional (deploy/multisig/operator/fund) em [MAINNET_READINESS_MOTOR1.md](./MAINNET_READINESS_MOTOR1.md).
> - Restam só itens não-bloqueantes: `GasFingerprintTracker`/`ActivityPatternTracker` (Fase 7+).

---

## TL;DR — quais motores REALMENTE disparam hoje

| Motor | Status real | Por quê |
|---|---|---|
| **Motor 1 — Liquidator** | ✅ Pode faturar (parcial) | Discovery + dispatcher reais. Estrangulado por: sem fallback de RPC (corrigido na Fase 1) e Aave/Seamless gated em `THEGRAPH_API_KEY` (corrigido na Fase 2). Edge real = Morpho. |
| **Motor 2 — MIS scanner** | ⚠️ Não fatura por design | Só observação (`mis_observed` no ledger). **Não tem caminho de execução**. ~40% pronto pra virar motor. |
| **Motor 3 — Backrun** | ❌ Morto em prod | Feed de mempool (`subscribeWhaleSwaps`) é **placeholder** — nunca emite `whale.swap_detected`. Só dispara via smoke test. |

---

## Achados por severidade

### 🔴 HIGH

**H1 — Motor 3 sem entrada real.** `packages/execution-utils/src/mempool/whaleSwapSubscription.ts`
(`subscribeWhaleSwaps`) é placeholder mesmo com `ALCHEMY_MEMPOOL_WSS_URL` setado — nunca assina
`alchemy_pendingTransactions`, nunca emite. Único emissor real de `whale.swap_detected` é
`emitSyntheticWhale` (smoke). Toda a tubulação do backrun (pipeline, dispatcher, bribe, market-bribe)
está pronta e **ociosa**. Conhecido (Base não tem mempool público; precisa Flashblocks WS / plano
premium). **Deferido — decisão de infra do Humberto.**

**H2 — Liquidator sem fallback de RPC.** `apps/liquidator/src/chainContext.ts` usa `http(rpc)` puro;
não há `fallback([...])` (que existe só no backrun). `.env.example` anuncia `BASE_RPC_FALLBACK` mas
nenhum código do liquidator lê. → **Corrigido na Fase 1** (usaremos Alchemy como fallback do dRPC).

**H3 — Aave + Seamless gated atrás de `THEGRAPH_API_KEY`** (`apps/liquidator/src/index.ts:~1584`). Sem
a key, Aave V3 **e** Seamless são pulados — inclusive o caminho on-chain do Seamless que não precisa de
subgraph. → **Corrigido na Fase 2** (on-chain sempre; TheGraph só acelerador).

**H4 — `fetchEthUsd` retorna 0 em falha → gás vira $0 → lucro inflado** no MIS
(`apps/mis-scanner/src/flashEstimator.ts`). Contamina o dataset do DRY_RUN. → **Corrigido na Fase 4.**

**H5 — mis-scanner sem schema de config.** Lê `process.env` cru; valor malformado vira
`setInterval(NaN)` (loop apertado) ou scanner mudo, sem lançar. → **Corrigido na Fase 4.**

**H6 — Backrun sem `deploy/fly/backrun-engine.toml` + volume.** Se subir, o ledger DuckDB zera a cada
redeploy. → **Deferido** (Fly.io aguardando recurso; o Humberto avisa ao subir).

### 🟡 MEDIUM

- **Seletor de flashloan 0% não ligado no arb/backrun** — `txBuilder.ts` força Aave 0,05%. Liquidator
  já está certo. → **Corrigido na Fase 3.**
- **`realized_priority_fee_wei` recebe `effectiveGasPrice` cheio** (base+priority) no backrun →
  superestima custo de inclusão. → **Corrigido na Fase 4.**
- **Scanner per-block agora roda em 2 apps** (liquidator + backrun pós-Fase 7) = 2× `getBlock`. No
  backrun (morto) é custo de RPC sem retorno. → **avaliar gate** (Fase 4/decisão).
- **`approvedDexAdapters` é regra do CLAUDE.md sem enforcement no contrato** — `_executeSwaps` aceita
  qualquer router; defesa real é `minProfitWei`+`onlyOperator`. → **Deferido (decisão: whitelist vs doc).**
- **`MOONWELL_LIQUIDATOR_ADDRESS` usa `optionalString()`** → endereço malformado passa no boot. →
  **Corrigido na Fase 4.**
- **`bUsd` colapsa token não-stable/não-WETH pro preço do ETH** + **`tickToSqrtPriceX96` perde ~130
  bits** (corrompe spot do MIS) + **BTC = 21×ETH** + sem guard de `ethUsdPrice` finito. → corrigir junto
  da limpeza de qualidade de dado do MIS (Fase 4 parcial; resto documentado).

### 🟢 LOW

- Intervals (`discoveryTick`, `pollBaseFee`) não capturados/limpos no shutdown — benigno hoje
  (`process.exit` + store guarda `shuttingDown`); importa no live.
- `slippage_bps`/`profit_delta_bps` bindados em INT32 sem `Math.round()` — não dispara hoje (blinda
  produtor fracionário futuro). → **Fase 4.**
- `whaleFromEvent` hardcoda decimals=18 (atrás do Motor 3 morto).
- `.env.example` com chave de fallback desalinhada. → **Fase 1.**

### ✅ Genuinamente sólido (verificado)
- **ABI ↔ Solidity batem campo-a-campo** (incl. variantes WithBribe), enums (`DexType`/`FlashSource`),
  cap de bribe (9900 bps). Deploy.s.sol bem cabeado.
- **DuckDB single-writer:** os 4 basenames distintos; flush/drain `await`ados; BIGINT roteado certo.
  ⚠️ Cuidado: se duas apps co-localizadas receberem o MESMO `INTELLIGENCE_DB_PATH` no `.toml`, colidem.
- **Quoting de DEX trata erro certo** (retorna `{reason}`, nunca zero-como-preço).
- Config Base mainnet 100% populada; gates default não travam dispatch.

---

## Respostas às perguntas do Humberto

### (2) As 8 classes exportadas e nunca instanciadas (mesmo bug do CooccurrenceAnalyzer)

| Classe | Motor | O que faz | Importância | Já existe pra alimentar |
|---|---|---|---|---|
| `CompetitorResolver` | M1 | Pós-falha: descobre QUEM nos ganhou (sender+gas) varrendo blocos vizinhos | ALTA | `FailureCollector`+`SenderRegistry` (`failureReporter.ts:191` hardcoded "não populou") |
| `PnlAggregator` | M1 | Agrega PnL por protocolo/venue/par/hora (24h/7d/30d) | ALTA | `PnlReconciler.reconcile()` |
| `CalibrationDriftTracker` | M1 | Alerta quando drift real-vs-esperado passa de -300bps sustentado | ALTA | `PnlReconciler` |
| `GasFingerprintTracker` | M1/M2 | p50/p95/p99 real de priority fee por competidor | MÉD-ALTA | `BlockHistoryScanner` |
| `BlockPositionTracker` | M1 | Posição da nossa tx no bloco (top/bottom 10% = corrida/sandwich) | MÉD | `TxStateMachine` |
| `ActivityPatternTracker` | M2 | Padrão temporal do competidor (bursts, horas de pico) | BAIXA-MÉD | `BlockHistoryScanner` |
| `OrphanRecoveryManager` | M1 (live) | Re-submete tx órfã pós-reorg — ver (3) | ALTA (só live) | `FinalityTracker.onReorg`+`TxStateMachine` |

Nenhuma é necessária pra dar trade — são camadas de **inteligência/segurança**. As de ALTA dão leverage
real de calibração. Plano: ligar as de ALTA na Fase 5 (opcional); `OrphanRecoveryManager` fica pro live.

### (3) O "órfão pós-reorg" (`OrphanRecoveryManager`)
Numa reorg de L2, o bloco onde nossa tx foi incluída pode ser **substituído** por uma cadeia que não
inclui nossa tx → ela vira "órfã": pagamos gás, sem resultado. O manager registra um callback ao
submeter, ouve `FinalityTracker.onReorg`, **revalida** a oportunidade e, se ainda válida, **re-submete**
com nonce novo (até 3 tentativas). **Só importa em modo live** — em DRY_RUN não há tx real pra
recuperar. É a única peça do módulo de finality ainda não ligada (já ligamos
`FinalityTracker`/`TxStateMachine`/`ReorgAnalytics`/`CacheInvalidator`).

### (7) Prontidão do Motor 2 (MIS)
**Inteligência ~85% / estrutura ~25% (total ~40%).** Pronto: derivação de pares, multicall de spot
price, detecção de divergência, flash sizing (`optimizeFlashLoan`), ranking por persistência, ledger
(`mis_observed`). Falta pra faturar: **nenhum caminho de execução** — sem contrato executor MIS, sem
builder de calldata, sem dispatcher, sem decoder pós-execução. Estimativa pra virar motor de execução:
**~8-11 dias** (contrato + builder + dispatcher + decoder + integração). Hoje é radar que alimenta o OIE.

### (9) Moonwell (impacto simplificado)
Hoje `MOONWELL_LIQUIDATOR_ADDRESS` é validado como **texto livre**. Um endereço com typo passa no boot
e só explode ao enviar a tx (gás desperdiçado / revert). Com `optionalAddress()`, o bot **falha no
startup** com erro claro. Risco hoje é baixo (há guard de presença), correção trivial. → Fase 4.

### (10) Seletor de flashloan (validação)
✅ **Ligado no liquidator** — `apps/liquidator/src/flashSourceSelector.ts` (`selectFlashSource` →
Morpho 0% > Balancer 0% > Aave 0,05%) é chamado nos 4 protocolos. ❌ **Não ligado no arb/backrun** —
`packages/strategy/src/executor/txBuilder.ts` força `flashSource: 0`. Contratos suportam as 3 fontes.
→ Fase 3 (portar o padrão, ~30 linhas).

---

## Status da remediação

| Item | Severidade | Ação | Fase |
|---|---|---|---|
| H2 RPC fallback liquidator | HIGH | Corrigir | 1 |
| H3 discovery on-chain sempre | HIGH | Corrigir | 2 |
| Seletor flashloan arb/backrun | MED | Corrigir | 3 |
| H4 fetchEthUsd guard | HIGH | Corrigir | 4 |
| H5 mis-scanner config zod | HIGH | Corrigir | 4 |
| M1 priority fee real | MED | Corrigir | 4 |
| Moonwell optionalAddress | MED | Corrigir | 4 |
| INT32 round bps | LOW | Corrigir | 4 |
| Ligar classes órfãs ALTA | MED | ✅ FEITO | 5 |

**Fase 5 (FEITO):** `PnlAggregator` + `CalibrationDriftTracker` (5a) e `CompetitorResolver` +
`BlockPositionTracker` (5b) ligados no liquidator. As 4 ficam **dormentes em DRY_RUN** (sem tx real /
sem reconciliação) e **prontas pra quando a TX ligar na MAIN**. `GasFingerprintTracker` /
`ActivityPatternTracker` (menor prioridade) e `OrphanRecoveryManager` (só live) seguem documentados.
| H1 Motor 3 mempool | HIGH | **Deferido** (infra) | — |
| H6 Fly backrun.toml | HIGH | **Deferido** (recurso) | — |
| Motor 2 execução (8-11d) | — | **Roadmap** | — |
| approvedDexAdapters | MED | **Decisão** (whitelist vs doc) | — |
