# 🔷 Dune — calibração de slippage por DEX (#5) + feed de inteligência

Usa o histórico de swaps REAIS da Base (via `dex.trades` do spellbook) pra calibrar o
`MAX_SLIPPAGE_BPS` **por DEX** — SEM esperar nossa execução na mainnet. Tira carga histórica
do RPC (o Dune é o "cérebro frio"; o RPC premium fica pro tempo real).

## Queries
- `slippage_by_dex.sql` — impacto de preço por DEX × faixa de tamanho (p50/p95/p99 bps). **#5.**

## Como rodar

**Pré-requisito:** `DUNE_API_KEY` no `.env` raiz (`DUNE_API_KEY=...`) + `curl` + `jq`.

### Caminho A — plano FREE (grátis)
1. Abre a UI da Dune → New Query → cola o conteúdo de `slippage_by_dex.sql` → Save → pega o **QUERY_ID** (na URL).
2. `./dune/run.sh <QUERY_ID>` → executa, aguarda, salva `dune/out/<id>.json` e imprime a tabela p50/p95 por DEX.

### Caminho B — plano PAGO (Plus+, tudo por API)
1. `./dune/create.sh dune/slippage_by_dex.sql "ZEUS #5 slippage"` → cria a query e devolve o QUERY_ID.
2. `./dune/run.sh <QUERY_ID>`.

## "Recortar e validar" (a doutrina do Humberto)
- **Recorte 1:** a janela (`interval '30' day`) — começa em 30d, sobe pra 90d se a amostra for pequena.
- **Recorte 2:** os pares (`token_bought_symbol IN (...)`) — começa nos que a gente opera, expande depois.
- **Validar:** o p95 por DEX vira a tabela `slippage_by_dex` que calibra o gate per-DEX. Quando a execução
  real rodar, comparamos o slippage MEDIDO (nosso) vs o previsto pelo Dune → confirma a calibração.

## Próximo passo (depois de validar a tabela)
- Embutir a tabela `slippage_by_dex` no config do bot (seed) → o gate de slippage deixa de ser global e
  passa a ser **por DEX**; o adaptativo (quando houver dado próprio) refina em cima.
- (Mainnet) cron via Dune API atualiza a tabela periodicamente = feed de inteligência vivo.

> `dune/out/` é ignorado no git (resultados, não segredos). O `DUNE_API_KEY` NUNCA é commitado.
