#!/usr/bin/env bash
# Roda os fork tests usando Alchemy (free serve archive/storage; dRPC free bloqueia com 408).
# Constrói BASE_RPC_HTTP a partir de ALCHEMY_API_KEY do .env raiz do monorepo.
#
#   pnpm contracts:test:fork                 # todos os fork tests
#   pnpm contracts:test:fork -- --match-contract MotorsProfit -vvv
set -e
ROOT_ENV="$(cd "$(dirname "$0")/.." && pwd)/.env"
KEY=$(grep -E '^ALCHEMY_API_KEY=' "$ROOT_ENV" | head -1 | cut -d= -f2- | tr -d "\"' \r")
if [ -z "$KEY" ]; then
  echo "ALCHEMY_API_KEY ausente no .env raiz — fork test exige RPC com archive (Alchemy)." >&2
  exit 1
fi
export BASE_RPC_HTTP="https://base-mainnet.g.alchemy.com/v2/$KEY"
echo "fork via Alchemy (base-mainnet)"
exec forge test --match-path 'test/fork/*' "$@"
