# Motor 1 (Liquidator) — Runbook de Prontidão MAINNET

> Estado do CÓDIGO: **pronto** (auditoria 2026-06-24 + fechamento das 3 pontas: whitelist on-chain de
> routers, stale-check Morpho/Moonwell, OrphanRecoveryManager pós-reorg). O que falta é **operacional**
> (deploy + provisionamento), listado aqui em ordem. Nada abaixo muda o comportamento do DRY_RUN.

## Princípio
Validar antes de escalar: **deploy mainnet → DRY_RUN 2 semanas → mainnet capital pequeno 4 semanas →
scale**. Nunca pular testnet/audit. Owner = multisig; operador = carteira separada.

---

## Fase A — Pré-deploy (provisionar)
1. **Safe multisig (owner)** — criar Safe na Base mainnet. Será o `owner` dos contratos (governança).
2. **Carteira do operador (bot)** — carteira dedicada (hardware/MPC), **separada do owner** e exclusiva
   do ZEUS EVM (nunca reusar chave). É quem assina os dispatches (`onlyOperator`).
3. **RPC** — Alchemy (archive incluso). Setar `BASE_RPC_HTTP` + `BASE_RPC_ARCHIVE` no `.env` do bot.
   Validar archive em mainnet (os fork tests passam com ele carregado: `set -a; . ./.env; set +a`).
4. **Capital** — decidir cap inicial. Recomendação conservadora: `MAX_TRADE_WEI=0.1 ETH` (~US$300),
   `MIN_LIQUIDATION_PROFIT_USD=5`, `DAILY_LOSS_LIMIT_USD=100`.

## Fase B — Deploy v9 (Base mainnet, chainid 8453)
5. `forge script script/Deploy.s.sol --rpc-url <BASE_MAINNET> --broadcast` (deployer temporário).
   - Deploya BribeManager + ZeusLiquidator + ZeusArbExecutor + ZeusMoonwellLiquidator.
   - Se `owner==deployer`, o script já seta WETH + UniV3 SwapRouter **e aprova o UniV3 router**
     (`setApprovedRouter`). Verificar os endereços impressos no log.
6. **Verify** dos 4 contratos no BaseScan (`BASESCAN_API_KEY`).
7. Registrar os endereços v9 no `CLAUDE.md`.

## Fase C — Pós-deploy (owner = Safe, executar via multisig)
> O kill switch nasce **ativo** e os contratos começam **default-deny** (sem operador, sem routers).
8. `transferOwnership(<Safe>)` + `acceptOwnership()` (Ownable2Step) nos 4 contratos → owner = multisig.
9. Em CADA executor (Liquidator + ArbExecutor + MoonwellLiquidator):
   - `revive()` — desativa o kill switch.
   - `setOperator(<bot_address>, true)` — autoriza a carteira do operador.
   - `setApprovedRouter(<router>, true)` — **whitelist on-chain** pra CADA router DEX usado. O UniV3
     já é aprovado no deploy (se owner==deployer); faltam os demais conforme `chain-config`:
     Aerodrome, Slipstream, Pancake V3, Sushi V3 (confirmar os que o Motor 1 realmente usa).
   - `setMaxTradePerToken(<token>, <cap>)` — teto por token (USDC/WETH/cbETH/DAI/USDT). **Default é
     vazio = a proteção por-token exige setar.**
10. **Fundar** a carteira do operador com gás (saldo > `GAS_RESERVE_CRITICAL_ETH`, default 0,01 ETH).

## Fase D — Calibração (DRY_RUN mainnet, ~2 semanas)
11. Subir o bot com `LIQUIDATOR_MODE=dryrun` (observa + grava no ledger DuckDB; **não** despacha).
    Preencher `GENERIC_WEBHOOK_URL` (painel) + `DISCORD_WEBHOOK_URL`.
12. Coletar dados reais e calibrar:
    - `MAX_SLIPPAGE_BPS` (default 50) com base no slippage real observado.
    - `MIN_DEBT_USD` / `MIN_LIQUIDATION_PROFIT_USD` (subir se o ledger mostrar ruído).
    - Decidir `MIN_OPPORTUNITY_EV_USD` (ativar pra **priorizar Morpho** — edge real; OEV come Aave/
      Compound/Moonwell). Opt-in: ausente = só loga.

## Fase E — Go-live (capital pequeno, 4 semanas)
13. Trocar pra `LIQUIDATOR_MODE=mainnet` com capital mínimo. `KILL_SWITCH=false` deliberado.
14. Monitorar pelo painel (heartbeat/health/latência/kill-switch/post-mortem agora fluem reais) +
    Discord. Escalar capital só após edge provado.

---

## Gates de segurança (já no código — confirmar valores antes do go-live)
| Gate | Default | Onde |
|---|---|---|
| Kill switch (auto) | ligado | `AUTO_KILL_SWITCH_ENABLED=true` |
| Perda diária | US$100 | `DAILY_LOSS_LIMIT_USD` |
| Stale-check pré-dispatch | ligado | `STALE_CHECK_ENABLED` (Aave/Compound/**Morpho**/**Moonwell**) |
| Oracle staleness | ligado | `ORACLE_STALENESS_CHECK_ENABLED` |
| Pause detector (protocolo paused) | ligado | `PAUSE_DETECTOR_ENABLED` |
| Reserva de gás crítica bloqueia dispatch | ligado | `BLOCK_DISPATCH_ON_CRITICAL_GAS=true` |
| Whitelist on-chain de routers | default-deny | `setApprovedRouter` (Fase C) |
| Recovery de tx órfã pós-reorg | ligado | OrphanRecoveryManager (dormente até tx real) |

## Pendências conhecidas (não bloqueiam Motor 1 mainnet)
- `GasFingerprintTracker` / `ActivityPatternTracker` — inteligência opcional de competidores (Fase 7+).
- Motor 2 (MIS execução) e Motor 3 (mempool) — planos próprios, depois do Motor 1.
