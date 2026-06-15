# ZEUS EVM — imagem única do monorepo. O app a rodar é escolhido por env APP.
# Ex.: APP=detector | mis-scanner | liquidator | backrun-engine
#
# Apps de observação rodam via tsx (sem build). Processos de longa duração (workers),
# sem porta HTTP exposta.
# syntax=docker/dockerfile:1

FROM node:22-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Build deps pra módulos nativos (@duckdb/node-api) caso o prebuilt não cubra a plataforma.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala deps com cache de layer (copia manifests primeiro).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY . .
RUN pnpm install --prod=false

# Volume persistente é montado em /data (ver fly.toml). O ledger DuckDB vive lá.
RUN mkdir -p /data /app/logs

# App default; cada fly.toml sobrescreve via [env] APP.
ENV APP=detector

CMD ["sh", "-c", "pnpm --filter @zeus-evm/$APP start"]
