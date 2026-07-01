#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Cria a query no Dune via API (a partir do .sql) e devolve o QUERY_ID.
# ⚠️ Criar query via API exige plano PAGO (Plus+). No FREE: crie na UI e use ./run.sh <id>.
#
# Uso: export DUNE_API_KEY=... ; ./dune/create.sh dune/slippage_by_dex.sql "ZEUS #5 slippage por DEX"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
SQL_FILE="${1:?uso: ./dune/create.sh <arquivo.sql> [nome]}"
NAME="${2:-ZEUS slippage_by_dex}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${DUNE_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  DUNE_API_KEY="$(grep -E '^DUNE_API_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
[ -n "${DUNE_API_KEY:-}" ] || { echo "❌ DUNE_API_KEY ausente"; exit 1; }

BODY="$(jq -n --arg name "$NAME" --arg sql "$(cat "$SQL_FILE")" \
  '{name:$name, query_sql:$sql, is_private:true}')"
RESP="$(curl -s -H "X-Dune-API-Key: $DUNE_API_KEY" -H "Content-Type: application/json" \
  -X POST "https://api.dune.com/api/v1/query" -d "$BODY")"
QID="$(echo "$RESP" | jq -r '.query_id // empty')"
[ -n "$QID" ] || { echo "❌ não criou (plano free?). Resposta:"; echo "$RESP" | jq .; exit 1; }
echo "✅ query criada: QUERY_ID=$QID"
echo "   agora: ./dune/run.sh $QID"
