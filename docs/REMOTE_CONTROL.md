# Controle remoto de execução (toggle do Frontend → bot)

> Status: **Motor 2 IMPLEMENTADO** · Motores 1 e 3 = design registrado (não implementado).
> Esta branch (`claude/motor-remote-control`) existe só pra registrar o design da generalização.

## O quê

Um botão no ZEUS Command (Frontend) que liga/desliga a **execução** (envio de transações) de cada
motor, sem redeploy nem mexer em `.env`. Modelo **armado-mas-travado**: o bot sobe com a wallet
pronta (armado) mas com o ENVIO **travado** por default; o toggle só **libera** o envio. Os circuit
breakers do contrato/off-chain (MAX_TRADE_ETH, min profit, simulação + EV gate, kill switch) seguem
valendo mesmo com o toggle ligado.

## Como funciona (já valendo no Motor 2)

```
ZEUS Command (painel)  ──POST /api/control──▶  Supabase `engine_control`
                                                      │  (1 linha por motor)
bot (mis-scanner)  ──poll a cada N scans──────────────┘
   └─ atualiza flag mutável `liveExecutionEnabled` em arbExec.deps
   └─ gate no dispatcher: if (mode==='dryrun' || !liveExecutionEnabled) → simula+observa, NÃO envia
   └─ estado REAL exposto em /readyz (dispatchesPaused) → painel compara desejado vs real
```

### Tabela `engine_control` (Supabase)
| coluna | tipo | nota |
|---|---|---|
| `motor` | text PK | `motor2` (hoje), depois `motor1`/`motor3` |
| `execution_enabled` | boolean default false | o toggle |
| `desired_mode` | text | dryrun/testnet/mainnet (futuro) |
| `updated_at` / `updated_by` | — | auditoria |

Escrita: **só** pelas rotas `/api` do Frontend (service role). Leitura: o bot via anon key (RLS read).

### Fail-safe (inviolável)
Qualquer incerteza → **travado** (`false`): sem `SUPABASE_URL`, erro de rede, HTTP não-ok, linha
ausente, valor não-`true`-exato. O bot **nunca** auto-liga na dúvida. Em `dryrun` o toggle é
irrelevante (nunca envia). Ver `apps/mis-scanner/src/engineControl.ts` (+ testes fail-safe).

## Generalização pros Motores 1 (liquidator) e 3 (backrun) — TODO

A mesma mecânica replica direto. Cada app pluga o gate no seu dispatcher:

1. **Schema**: já suporta — `engine_control` tem 1 linha por motor (`motor1`, `motor3`). Seed adicional.
2. **Liquidator (Motor 1)** — `apps/liquidator/src/dispatcher.ts`:
   - Adicionar `liveExecutionEnabled?: boolean` (default false) às deps do dispatcher.
   - No ponto de submit (modo `mainnet`/`testnet`), gate: travado → simula/loga e NÃO envia.
   - Poll do Supabase no loop principal (reusar `fetchEngineControlEnabled` com `motor='motor1'`).
   - Refletir em `/readyz` (`dispatchesPaused`).
3. **Backrun (Motor 3)** — `apps/backrun-engine/src/` (idem). ⚠️ Motor 3 está BLOQUEADO em prod por
   outro motivo (feed de mempool placeholder — ver `docs/LOOSE_WIRES.md`); o toggle não muda isso.
4. **Reuso**: extrair `fetchEngineControlEnabled` + a config (`SUPABASE_URL/KEY`, `ENGINE_CONTROL_MOTOR`,
   `ENGINE_CONTROL_POLL_EVERY`) pra `@zeus-evm/execution-utils` quando o 2º motor adotar (hoje vive
   no mis-scanner; promover evita duplicação). O Frontend (`/api/control` + UI) já aceita os 3 motores.

## Referências (implementação Motor 2)
- Bot: `apps/mis-scanner/src/engineControl.ts`, `execution/arbDispatcher.ts` (gate), `index.ts` (poll + health), `config.ts`.
- Frontend: `frontend/app/api/control/route.ts`, `frontend/components/screens/Settings.tsx`, `frontend/supabase/schema.sql`.
