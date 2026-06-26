#!/usr/bin/env bash
# Roda os fork tests usando um RPC com ARCHIVE (Alchemy free serve archive/storage; dRPC free
# bloqueia com 408 "Request timeout on the free tier"). Fonte da URL, em ordem de preferência:
#   1. BASE_RPC_ARCHIVE no .env raiz (endpoint archive dedicado)
#   2. BASE_RPC_HTTP no .env raiz (se já for Alchemy/archive)
#   3. construída a partir de ALCHEMY_API_KEY no .env raiz
#
#   pnpm contracts:test:fork                                   # todos os fork tests
#   (p/ filtrar, rode o script direto — pnpm repassa o `--` literal em algumas versões:)
#   bash contracts/fork-test.sh --match-contract ZeusArbExecutorDexForkTest -vv
set -e
ROOT_ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"
getenv() { grep -E "^$1=" "$ROOT_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\"' \r"; }

ARCHIVE="$(getenv BASE_RPC_ARCHIVE)"
[ -z "$ARCHIVE" ] && ARCHIVE="$(getenv BASE_RPC_HTTP)"
case "$ARCHIVE" in
  *alchemy*) ;;                    # já é Alchemy (archive) — usa direto
  *) ARCHIVE="" ;;                 # outro provider: não garante archive → tenta a key abaixo
esac
if [ -z "$ARCHIVE" ]; then
  KEY="$(getenv ALCHEMY_API_KEY)"
  [ -n "$KEY" ] && ARCHIVE="https://base-mainnet.g.alchemy.com/v2/$KEY"
fi
if [ -z "$ARCHIVE" ]; then
  echo "Sem RPC archive: defina BASE_RPC_ARCHIVE (ou ALCHEMY_API_KEY) no .env raiz." >&2
  exit 1
fi

# O teste lê BASE_RPC_ARCHIVE (preferido) → BASE_RPC_HTTP. Exporta ambos p/ cobrir todos os forks.
export BASE_RPC_ARCHIVE="$ARCHIVE"
export BASE_RPC_HTTP="$ARCHIVE"
echo "fork via archive RPC (base-mainnet, Alchemy)"
exec forge test --match-path 'test/fork/*' "$@"
