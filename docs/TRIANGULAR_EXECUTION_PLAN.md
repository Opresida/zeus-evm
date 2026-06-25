# Plano — Caminho de execução da arbitragem TRIANGULAR (Motor 2)

> Status: **PLANEJADO, não implementado.** Detecção já roda read-only; este doc descreve a "cola"
> off-chain que falta pra transformar um ciclo detectado em transação enviável.
> Gatilho pra começar: o painel mostra o aviso **"Lucro provado, hora de implementar a ligação da
> arb triangular"** (Home), que dispara quando a arb de 2 pernas acumula lucro real (ver fim do doc).

## Contexto

O Motor 2 detecta ciclos triangulares A→B→C→A em [apps/mis-scanner/src/index.ts:685-702](../apps/mis-scanner/src/index.ts#L685)
via `findTriangularCycles` (reusa os spots do scan, sem RPC extra). Hoje o resultado é **só observado**:
loga (`🔺 ciclo(s) triangular(es) lucrativo(s)`) e grava no ledger DuckDB como `arb_triangular_observed`.
**Nunca** vai pro `dispatchArb`. Não existe caminho de execução.

A parte mais difícil **já existe**: o contrato `ZeusArbExecutor.executeFlashloanArbitrage` aceita **multi-hop
N steps** (= triangular) com flashloan de 3 fontes (Aave/Morpho/Balancer). Falta a tradução off-chain:
**ciclo detectado → calldata → sizing → simulação → dispatch**, atrás do **mesmo toggle** da arb de 2 pernas.

## O que falta construir (off-chain)

### 1. Tipo de oportunidade triangular + builder de calldata
- Hoje o `dispatchArb` recebe `CrossDexOpportunity` (2 pernas: buyQuote + sellQuote). O ciclo triangular
  tem **N legs** (`cyc.legs` com `poolLabel`/DEX por perna) e `cyc.tokens` (A,B,C).
- Criar um `TriangularOpportunity` (ou estender `CrossDexOpportunity` p/ N pernas) e um builder que monte
  os **swap-steps multi-hop** no formato que o `ZeusArbExecutor.executeFlashloanArbitrage` espera —
  reusando os adapters de DEX já existentes (`UniswapV3Lib`, `AerodromeLib`, PancakeV3, Slipstream...).
- Reusar `buildFlashloanCalldata` (hoje 2 pernas) generalizando p/ a lista de pernas, OU um
  `buildTriangularCalldata` irmão.

### 2. Flash sizing do ciclo
- Reusar a ideia do `flashEstimator` (M2) — cotar FRESCO o round-trip das 3 pernas + taxa de flashloan,
  achar o `amountIn` ótimo e checar profundidade (descartar pool raso). 3 pernas = mais slippage acumulado.

### 3. Gate de EV específico (margens mais finas)
- 3 pernas = **mais gás** + **3× exposição a slippage**. O `filterOpportunity` precisa de parâmetros próprios
  (gás estimado maior; talvez `MIN_TRI_PROFIT_USD` separado, mais exigente que o de 2 pernas).
- **Token-safety nas 3 paradas** (não só nas 2) — reusar o filtro/allowlist de tokens do M2.

### 4. Simulação + dispatch atrás do MESMO toggle
- Re-cota fresco + `simulateArbitrage` (eth_call) do ciclo inteiro antes de qualquer envio.
- Rotear pelo **mesmo `dispatchArb`** (ou irmão que compartilhe o gate): assim herda DE GRAÇA o
  modelo **armado-mas-travado** (`liveExecutionEnabled`), as defesas de maturidade (reorg, auto-pause,
  latência) e a gorjeta competitiva — tudo já ligado.

### 5. Granularidade do liga/desliga (recomendado)
- **Chave-mestra** = o toggle remoto atual (`engine_control` → `liveExecutionEnabled`): corta TODA a
  execução do M2 (2 pernas + triangular).
- **Sub-interruptor próprio** = `TRIANGULAR_EXECUTION_ENABLED` (env, **default false**), gated SOB a
  chave-mestra. Permite ligar a arb de 2 pernas (validada) sem disparar triangular (ainda não provada).
  Mesmo padrão do `COMPETITIVE_BRIBE_ENABLED`. Doutrina: **validar antes de escalar**.

## Arquivos que seriam tocados
- `packages/strategy/` — novo `TriangularOpportunity` + builder de calldata multi-hop + sizing + EV gate tri.
- `apps/mis-scanner/src/execution/arbDispatcher.ts` (ou irmão) — aceitar o ciclo e despachar pelo mesmo gate.
- `apps/mis-scanner/src/index.ts` — no loop, quando `cycles` lucrativos E `TRIANGULAR_EXECUTION_ENABLED`,
  passar o melhor ciclo ao dispatch (hoje só observa).
- `apps/mis-scanner/src/config.ts` — `TRIANGULAR_EXECUTION_ENABLED` + `MIN_TRI_PROFIT_USD`.
- Testes: builder de calldata tri, sizing, EV gate, e o dispatch atrás do toggle (mocks, sem RPC).

## Segurança (invariantes — iguais ao resto do M2)
- **Atômico/flashloan-only**: ciclo inteiro numa tx; qualquer perna que falhe reverte tudo (só gás).
- **Backstop on-chain** (`minProfitWei`) reverte se o líquido não fechar.
- **Default OFF** + sub-toggle próprio + chave-mestra remota. Nunca dispara sem opt-in explícito.
- Token-safety nas 3 pernas inegociável.

## Gatilho no painel (JÁ implementado)
- `frontend/lib/viewModel.ts` (`triangularReady`): quando o lucro líquido ACUMULADO do Motor 2 (arb) ≥
  `TRIANGULAR_PROVEN_PROFIT_USD` (default $50) E nº de ops ≥ `TRIANGULAR_MIN_OPS` (default 20), no modo
  AO VIVO. Em DRY_RUN o netUsd do M2 é 0 (não envia) → o aviso só aparece quando a arb de 2 pernas faz
  dinheiro real.
- `frontend/components/screens/Home.tsx`: banner verde no topo da Visão Geral —
  **"Lucro provado, hora de implementar a ligação da arb triangular"** + detalhe (quanto acumulou / ops).
- Ajuste fino dos limiares nos dois `const` do `viewModel.ts`.
