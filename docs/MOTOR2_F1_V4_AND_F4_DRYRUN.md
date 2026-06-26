# Motor 2 — F1 (cobertura Uniswap V4) + F4 (DRY_RUN): plano + runbook

> Estado em 2026-06-26: F2 (contrato) e F3 (app + feed validado contra API real) PRONTOS e testados.
> Este doc fecha o desenho da F1 (V4) e o runbook da F4 (DRY_RUN). Honestidade > otimismo: a
> EXECUÇÃO V4 mexe em fundo (caminho de swap) → build cuidadoso com fork test, não às pressas.

---

## Por que V4 importa (do recon)

O líder filler (`0xa0e582bf…`) roteia por **13 contratos, 2,56M de gás, incluindo o Uniswap V4
PoolManager** (`0x498581fF…`, confirmado via `owner()`). V4 é liquidez que o nosso roteador
(UniV3/Aerodrome/Slipstream/UniV2/Pancake) **não acessa** → perdemos as fills cuja melhor rota passa
por V4. Cobrir V4 = subir o win-rate. Infra confirmada on-chain na Base:

| Peça | Endereço | Status |
|---|---|---|
| V4 PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | ✅ confirmado |
| V4 Quoter | `0x0d5e0F971ED27FBfF6c2837bf31316121532048D` | ✅ tem código (11,6 KB) |
| Universal Router (exec V4) | `0x6fF5693b99212Da76ad316178A184AB56D299b43` | ✅ tem código (39 KB) |

---

## F1a — Cotação V4 OFF-CHAIN (intelligence, zero risco de contrato)

Objetivo: o bot ENXERGAR preços V4 pra comparar com V3 e quantificar o ganho.

1. **Descoberta de pool:** ler eventos `Initialize(id, currency0, currency1, fee, tickSpacing, hooks, …)`
   do PoolManager → montar a `PoolKey` por par. (Há múltiplos pools por par: fee/tickSpacing/hooks
   variados. Filtrar por liquidez.) Cachear como o `buildPreLiquidationCache`.
2. **Quote:** `V4Quoter.quoteExactInputSingle({poolKey, zeroForOne, exactAmount, hookData})` via eth_call.
   Adapter novo `quoteUniswapV4` em `dex-adapters` (espelha `quoteUniswapV3`), retornando `Quote` com
   `extraData = abi.encode(poolKey)` pro builder.
3. **Wire:** o `bestQuote` do runner (Motor 2/F3) passa a comparar V3 vs V4 → escolhe a melhor.
   Em DRY_RUN, logar quando V4 ganharia → **mede o uplift real de cobrir V4** antes de gastar no on-chain.

**Esforço:** médio. **Risco:** baixo (read-only). **Entrega:** o número que justifica (ou não) a F1b.

## F1b — Execução V4 ON-CHAIN (caminho de fundo — build cuidadoso)

Duas opções de execução:

- **(A) Universal Router** (recomendado): o contrato aprova Permit2 → chama
  `UniversalRouter.execute(commands=[V4_SWAP], inputs, deadline)`. A UR resolve o `unlock` do PoolManager
  internamente. Adicionar `UniswapV4Lib.swap` que encoda o comando V4_SWAP (actions
  `SWAP_EXACT_IN_SINGLE`+`SETTLE_ALL`+`TAKE_ALL` + a PoolKey) + `DexType.UniswapV4` no enum.
- **(B) PoolManager.unlock direto:** o contrato implementa `IUnlockCallback` e faz swap+settle+take na
  callback. Mais barato em gás, mais código novo no contrato.

**Passos (disciplina da casa):**
1. `DexType.UniswapV4` no `@zeus-evm/shared-types` (FONTE ÚNICA) — o **pin test** exige sincronizar TS↔Solidity.
2. `UniswapV4Lib.sol` (opção A) + dispatch no `_executeSwaps` dos contratos que usam swap (filler + arb).
3. Aprovação Permit2 (one-time) + encoding do comando — **a parte sensível** (encoding errado = revert).
4. **Fork test obrigatório** contra um pool V4 real na Base (swap WETH→USDC via UR) — prova o caminho.
5. `forge build --sizes` (EIP-170) + redeploy testnet.

**Esforço:** alto. **Risco:** mexe em fundo → **NÃO fazer às pressas.** Merece sessão focada + o mesmo
rigor de fork test que usamos no F2. É a única peça do Motor 2 que toca o caminho de capital.

---

## F4 — DRY_RUN runbook (o que mede o win-rate real)

Pré-requisitos prontos: feed validado contra a API real (F3), avaliador testado, contrato deployável.

1. **`.env` do bot (VM):** `UNISWAPX_FILLER_ENABLED=true`, `ARB_MODE=dryrun` (NÃO envia), Base RPC.
   Sem `UNISWAPX_FILLER_ADDRESS` ou em dryrun → o runner só **observa e loga** os candidatos.
2. **Rodar o mis-scanner** uns dias. A cada tick: puxa ordens abertas → avalia → loga
   `🎯 fill candidato: lucro ~$X`. (Já grava no ledger/eventos da inteligência do Motor 2.)
3. **Medir:** quantas ordens/dia avaliaríamos com lucro > min, qual o lucro agregado teórico, e
   (com F1a) quantas só fechariam via V4 → **win-rate estimado vs os 18 fillers**.
4. **Critério de ligar (F5):** win-rate + lucro agregado que justifique. Só então: deploy do filler na
   main + `UNISWAPX_FILLER_ADDRESS` + `setApprovedReactor(V2,V3)` + `ARB_MODE=mainnet` + toggle do painel.

> O DRY_RUN roda na VM do Humberto (o cloud não tem o bot rodando em loop). O código está pronto pra
> isso: default OFF, fail-safe, e a inteligência (ledger/eventos) já captura os candidatos.

---

## Resumo de prioridade

| Peça | Risco | Quando |
|---|---|---|
| F1a (quote V4 off-chain) | baixo | próxima sessão — mede o uplift |
| F4 (DRY_RUN) | nenhum | rodar na VM JÁ (com o que temos) — observa win-rate sem V4 |
| F1b (exec V4 on-chain) | **alto (fundo)** | sessão focada + fork test, SÓ se o DRY_RUN justificar |

**Recomendação honesta:** rodar a F4 (DRY_RUN) JÁ com a cobertura atual mede o win-rate base. F1a
quantifica o quanto V4 somaria. Só aí decidir a F1b (a peça cara/sensível). É a doutrina: medir antes
de mexer no caminho de capital.
