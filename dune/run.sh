#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Runner do Dune (#5 slippage por DEX): executa uma query SALVA por ID, aguarda,
# busca o resultado e imprime como tabela. Fluxo oficial da Dune API v1.
#
# Uso:
#   export DUNE_API_KEY=...           # (ou põe no .env raiz: DUNE_API_KEY=...)
#   ./dune/run.sh <QUERY_ID>          # QUERY_ID = a query criada na UI da Dune com o slippage_by_dex.sql
#
# Requisitos: curl + jq. Salva o JSON bruto em dune/out/<QUERY_ID>.json.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
QUERY_ID="${1:?uso: ./dune/run.sh <QUERY_ID>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# carrega DUNE_API_KEY do .env raiz se não estiver no ambiente
if [ -z "${DUNE_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  DUNE_API_KEY="$(grep -E '^DUNE_API_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
[ -n "${DUNE_API_KEY:-}" ] || { echo "❌ DUNE_API_KEY ausente (ambiente ou .env raiz)"; exit 1; }

API="https://api.dune.com/api/v1"
H=(-H "X-Dune-API-Key: $DUNE_API_KEY")

echo "▶️  Executando query $QUERY_ID ..."
EXEC_ID="$(curl -s "${H[@]}" -X POST "$API/query/$QUERY_ID/execute" | jq -r '.execution_id')"
[ "$EXEC_ID" != "null" ] && [ -n "$EXEC_ID" ] || { echo "❌ falha ao iniciar execução (chave/plano/ID?)"; exit 1; }
echo "    execução: $EXEC_ID"

# poll do status
for i in $(seq 1 60); do
  STATE="$(curl -s "${H[@]}" "$API/execution/$EXEC_ID/status" | jq -r '.state')"
  echo "    [$i] estado: $STATE"
  case "$STATE" in
    QUERY_STATE_COMPLETED) break ;;
    QUERY_STATE_FAILED|QUERY_STATE_CANCELLED) echo "❌ execução terminou em $STATE"; exit 1 ;;
  esac
  sleep 5
done

mkdir -p "$ROOT/dune/out"
OUT="$ROOT/dune/out/$QUERY_ID.json"
curl -s "${H[@]}" "$API/execution/$EXEC_ID/results" > "$OUT"
echo "✅ resultado salvo em dune/out/$QUERY_ID.json"
echo ""
echo "═══ p95 slippage (bps) por DEX × faixa de tamanho ═══"
jq -r '.result.rows[] | [.dex, .size_bucket, .trades, .p50_slippage_bps, .p95_slippage_bps] | @tsv' "$OUT" 2>/dev/null \
  | awk 'BEGIN{printf "%-16s %-14s %8s %8s %8s\n","DEX","TAMANHO","TRADES","p50bps","p95bps"} {printf "%-16s %-14s %8s %8s %8s\n",$1,$2,$3,$4,$5}'
