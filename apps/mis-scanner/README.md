# MIS Scanner — Market Inefficiency Scanner (Motor 2)

Varredura de ineficiências de mercado em DEXs de Base. **Observação pura** — sem
capital, sem submeter tx. Lê estado on-chain, calcula divergências de preço local
e ranqueia por **persistência** (não magnitude).

## Como rodar (padrão atual — sem VM 24/7)

```bash
# Ao chegar: inicia a varredura
pnpm --filter @zeus-evm/mis-scanner start

# Deixa rodando até ir embora. Ctrl+C salva o snapshot.
```

O histórico é **persistido em disco** (`logs/mis/base-mis-snapshot.json`). Ao
reiniciar no dia seguinte, recarrega e continua acumulando — a persistência
(sinal-chave do MIS) cresce dia após dia mesmo sem rodar 24/7.

## Env (lê do .env da raiz do monorepo)

- `BASE_RPC_HTTP` — RPC de Base (obrigatório)
- `MIS_SCAN_INTERVAL_MS` — intervalo entre scans (default 12000 = ~1 bloco)
- `MIS_MIN_DIVERGENCE_BPS` — divergência mínima pra contar como ineficiência (default 20)
- `MIS_RANKING_EVERY` — loga ranking a cada N scans (default 25)

## O que ele varre

Pares curados em `src/poolGroups.ts` (tese LSD/stable sub-servidos):
cbETH/WETH, USDC/USDbC, DAI/USDC, USDT/USDC, WETH/USDC, cbETH/USDC, AERO/WETH.

Pools resolvidos **on-chain via factory** (UniV3 todos fee tiers + Aerodrome
stable/volatile) — sem hardcode de endereço.

## Output

- A cada scan: divergências ativas (≥ threshold)
- A cada N scans: ranking de ineficiência persistente (score = persistência × magnitude)

## Próximo passo

Deploy 24/7 na Fly.io (igual liquidator/backrun) pra varredura contínua.
