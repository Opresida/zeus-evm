# HANDOFF — Expansão de DEX (Motor 2) + Toggle remoto de execução

> **⭐ ATUALIZAÇÃO PÓS-REVIEW (2026-06-23) — correções aplicadas nesta branch antes do merge:**
> - **Enum `DexType` unificado:** era triplicado e dessincronizado (`Slipstream=5` só entrou em 2 de 3).
>   Agora `packages/shared-types` é a **fonte única TS** (`dex-adapters` re-exporta); espelhado no
>   Solidity; **pin test** (`dex-adapters/src/dexType.pin.test.ts`) trava o CI se dessincronizar.
> - **Pancake V3 resolvido (não é mais red flag):** a struct `exactInputSingle` do Pancake tem
>   `deadline` → ganhou **adapter dedicado** `PancakeV3Lib.sol` + `DexType.PancakeV3` (6). Off-chain é
>   config-driven: cada fork em `univ3Forks` tem `routerStyle: 'uniswapV3' | 'pancakeV3'`. Pricing
>   segue na trilha UniV3 (slot0); só a EXECUÇÃO desvia.
> - **⚠️ ACHADO no fork test — Sushi V3 na Base TAMBÉM precisa de deadline:** a anotação original
>   dizia "Sushi V3 é SwapRouter02-compatível" — **ERRADO**. Verificado on-chain (fork em bloco
>   recente, RPC free): o swap **reverte** via `DexType.UniswapV3` e **passa** via `DexType.PancakeV3`.
>   Corrigido → `sushiswap-v3` agora é `routerStyle: 'pancakeV3'`. Liquidez do pool é saudável (~48
>   WETH no 0.05%); não era falta de pool. **Os 4 fork tests passam on-chain no bloco fixado 28M**
>   (BaseSwap, Slipstream, Pancake V3, Sushi V3) via **Alchemy free (já serve archive)** — o dRPC free
>   é que não forkava. `pnpm contracts:test:fork` é plug-and-play; CI roda os fork tests (job
>   `contracts-fork`) com o secret `BASE_RPC_ARCHIVE` = trap automático contra endereço morto/errado.
> - **TODOS os endereços de venue verificados on-chain (2026-06-23):** OK os 5 UniV2 vivos + Pancake/Sushi
>   V3 + Slipstream. **Removidos:** `dackieswap-v2` (router sem bytecode) e `rocketswap` (sem nenhum par
>   curado). tickSpacing 2000 do Slipstream confirmado real; pool WETH/USDC fundo no tick 100.
> - **`/api/control` fail-closed:** o POST (liga/desliga execução) agora é **recusado (503) em
>   produção sem `ZEUS_CONTROL_SECRET`**. Melhor ainda: painel atrás de Vercel Auth.
>
> **HISTÓRICO (já superado pela atualização acima):** as branches foram mergeadas na `main`
> (`claude/bot-performance-analysis-55qp9o` = código; `claude/motor-remote-control` = doc M1/M3).
> As seções abaixo (§1 "tarefas do Humberto" e §2 "red flags de endereços") refletem o estado
> ORIGINAL do dev (sem RPC da Base, nada verificado) — **a maioria já foi resolvida**: endereços
> verificados, Pancake/Sushi com adapter de deadline, dackie/rocket removidos, RPC = Alchemy.
> Mantidas só como registro. O que REALMENTE falta hoje: setar secret `BASE_RPC_ARCHIVE` no CI +
> setar `ZEUS_CONTROL_SECRET`/auth do painel + schema Supabase + **redeploy só testnet** dos contratos.

---

## 0) Resumo do que foi entregue

**Parte A — mais DEX no Motor 2** (mais lucro observável: mais pares passam do filtro ≥2 pools + mais spreads/ciclos):
- **Slipstream** (Aerodrome CL) — `DexType.Slipstream=5`, `SlipstreamLib.sol`, adapter off-chain. **Exige redeploy.**
- **Forks UniV3** (Pancake/Sushi) — reusam `DexType.UniswapV3` com router/quoter próprios. **Sem redeploy.**
- **UniV2 genérico** (BaseSwap/AlienBase/SwapBased) — `DexType.UniswapV2`, `UniswapV2Lib.sol`, adapter. **Exige redeploy.**

**Parte B — toggle remoto** (armado-mas-travado): painel → `/api/control` → Supabase `engine_control` → bot poll → gate no dispatcher. Fail-safe: dúvida = travado.

**EIP-170:** `ZeusArbExecutor` 14.823 → **15.772 B** (+949 B). Folga **8.804 B** até 24.576. OK, sem contrato extra.

---

## 1) ✅ Próximos passos (TAREFAS DO HUMBERTO)

### 1.1 Verificar endereços on-chain (BLOQUEANTE antes de redeploy/ligar)
Rodar com um RPC da Base (`cast` do Foundry). **Cada um precisa retornar endereço != 0x000…0.**
Ver a seção **§2 Red flags** abaixo pros comandos exatos por venue.

### 1.2 Rodar os fork tests (são a verificação on-chain automatizada)
```bash
cd contracts
export BASE_RPC_HTTP="<seu RPC Base>"
forge test --match-path "test/fork/ZeusArbExecutorDex.fork.t.sol" -vvv
```
- **Se passar:** endereços de BaseSwap + Slipstream (router/tickSpacing) estão corretos.
- **Se falhar:** o endereço/tickSpacing daquele venue está errado → corrigir em `packages/chain-config/src/base.ts`.
- ⚠️ O fork test cobre **BaseSwap (UniV2)** e **Slipstream**. **NÃO cobre Pancake/Sushi nem AlienBase/SwapBased** — verificar esses manualmente (§2).

### 1.3 Redeploy dos contratos (só Slipstream + UniV2 exigem) — **APENAS TESTNET primeiro**
- Regra inviolável: testnet 2 semanas → mainnet capital pequeno → audit. **Não pular.**
- Atualizar `script/Deploy.s.sol` se necessário e os endereços v8 no `CLAUDE.md` após deploy.
- Forks Pancake/Sushi **não** exigem redeploy (reusam DexType.UniswapV3 on-chain).

### 1.4 Setup do Supabase (pro toggle funcionar)
1. Rodar o SQL atualizado: `frontend/supabase/schema.sql` (cria `engine_control` + seed `motor2` travado + RLS read).
2. Confirmar que a **anon key tem leitura** em `engine_control` (a policy `engine_control read` faz isso).

### 1.5 Variáveis de ambiente
**Bot (mis-scanner) — pra ARMAR a execução (continua travada até o toggle):**
```
ARB_EXECUTION_ENABLED=true
ARB_MODE=mainnet            # ou testnet
EXECUTOR_PRIVATE_KEY=0x...  # chave EXCLUSIVA (regra inviolável)
ARB_EXECUTOR_ADDRESS=0x...  # endereço do contrato redeployado
ARB_PROFIT_RECEIVER=0x...
SUPABASE_URL=https://<proj>.supabase.co
SUPABASE_KEY=<anon key (read em engine_control)>
# opcionais: ENGINE_CONTROL_MOTOR=motor2  ENGINE_CONTROL_POLL_EVERY=5
```
> Sem `SUPABASE_URL` → execução fica **travada permanente** (fail-safe). Em `ARB_MODE=dryrun` o toggle é irrelevante.

**Frontend (Vercel):**
```
NEXT_PUBLIC_SUPABASE_URL=...        # já usado
SUPABASE_SERVICE_ROLE_KEY=...       # já usado (rotas /api)
ZEUS_CONTROL_SECRET=...             # OPCIONAL — ver red flag §3.1 (auth do painel)
```

### 1.6 Decisão sua (aguardando): **só ligar o toggle quando o edge estiver provado no DRY_RUN/ledger.** Ligar = dinheiro real (a UI pede dupla confirmação).

---

## 2) 🚩 RED FLAGS de RPC / endereços (verificar TUDO antes de usar)

> ✅ **JÁ RESOLVIDO (2026-06-23) — esta seção é histórica.** Todos os endereços foram verificados
> on-chain via Alchemy archive. Vivos: BaseSwap/AlienBase/SwapBased/Pancake-v2/Sushi-v2 (UniV2) +
> Pancake V3 + Sushi V3 + Slipstream. **Removidos:** dackieswap-v2 (router morto) e rocketswap (sem
> par curado). O "RED FLAG CRÍTICO Pancake V3 deadline" abaixo foi resolvido com `PancakeV3Lib` +
> `DexType.PancakeV3` (e Sushi V3 entrou no mesmo barco). Não precisa refazer nada daqui manualmente
> — o job `contracts-fork` no CI revalida automático.

Todos os endereços abaixo estão em `packages/chain-config/src/base.ts` (`univ2Dexes`, `univ3Forks`, `slipstream`). _(Estado original: marcados `⚠️ VERIFICAR`, nenhum conferido on-chain — ver banner acima.)_
Token de teste pros comandos: USDC=`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, WETH=`0x4200000000000000000000000000000000000006`.

### 2.1 UniV2 (BaseSwap / AlienBase / SwapBased) — `factory.getPair`
```bash
# deve retornar um pool != 0x000...0
cast call <FACTORY> "getPair(address,address)(address)" <USDC> <WETH> --rpc-url $BASE_RPC_HTTP
```
- **baseswap** factory `0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB` — já estava no repo (confiança alta).
- **alienbase** factory `0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7` — 🚩 verificar.
- **swapbased** factory `0x04C9f118d21e8B767D2e50C946f0cC9F6C367300` — 🚩 verificar.
- **pancakeswap-v2** factory `0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E` — 🚩 verificar (config-only adicionado na 2ª passada).
- **sushiswap-v2** factory `0x71524B4f93c58fcbF659783284E38825f0622859` — 🚩🚩 verificar (router/factory do Sushi V2 na Base de menor confiança).
- **dackieswap-v2** factory `0x591f122D1df761E616c13d265006fcbf4c6d6551` — 🚩🚩 verificar.
- **rocketswap** factory `0x1B8eea9315bE495187D873DA7773a874545D9D48` — 🚩🚩 verificar.
- Routers correspondentes idem. **NENHUM desses V2 extras é coberto por fork test** — verificar todos via `cast` (§2.1 comando acima).
- ✅ **Importante:** estes forks UniV2 são **config-only** (sem código novo, **sem redeploy** — a `UniswapV2Lib` já roteia). Endereço errado = venue resolve a 0 pools (inofensivo em DRY_RUN). Remover/comentar a linha em `base.ts` desabilita.

### 2.2 Forks UniV3 (Pancake / Sushi) — `factory.getPool` + **ABI do SwapRouter**
```bash
cast call <FACTORY> "getPool(address,address,uint24)(address)" <USDC> <WETH> 500 --rpc-url $BASE_RPC_HTTP
```
- **pancakeswap-v3** factory `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865`, quoter `0xB048Bbc1...`, swapRouter `0x1b81D678...`, feeTiers **[100,500,2500,10000]** (2500, não 3000!) — 🚩 verificar.
- **sushiswap-v3** factory `0xc35DADB6...`, quoter `0xb1E835Dc...`, swapRouter `0xFB7eF66a...` — 🚩🚩 **menor confiança** (endereços de quoter/router do Sushi V3 na Base variam).
- 🚩🚩 **RED FLAG CRÍTICO — Pancake V3 `exactInputSingle`:** o on-chain reusa `UniswapV3Lib.swap` que chama
  `exactInputSingle` **SEM campo `deadline`**. O SmartRouter da PancakeSwap V3 pode ter struct com
  `deadline` → a chamada **reverte**. **Testar Pancake num fork** (swap USDC→WETH via DexType.UniswapV3
  com router Pancake). Se reverter, criar `PancakeV3Lib.sol` com o struct certo (tem `deadline`) e
  mapear Pancake pra um DexType próprio. Sushi normalmente é SwapRouter02-compatível (sem deadline).

### 2.3 Slipstream (Aerodrome CL) — `CLFactory.getPool` + ABI do Quoter/Router
```bash
# getPool usa int24 tickSpacing (NÃO uint24 fee)
cast call <CLFACTORY> "getPool(address,address,int24)(address)" <USDC> <WETH> 100 --rpc-url $BASE_RPC_HTTP
```
- factory `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`, quoter `0x254cF9E1...`, swapRouter `0xBE6D8f0d...`, tickSpacings **[1,50,100,200,2000]** — 🚩 verificar.
- 🚩 **tickSpacing do par WETH/USDC** assumido = **100** no fork test (`SLIP_WETH_USDC_TICK_SPACING`). Se o pool real for outro (50/200), o fork test falha → ajustar a constante no teste **e** confirmar a lista `tickSpacings`.
- 🚩 **ABI do Slipstream Quoter** (`packages/dex-adapters/src/slipstream/quoter.ts`): assumi
  `quoteExactInputSingle((tokenIn,tokenOut,amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96))`.
  Confirmar contra o quoter deployado (se divergir, ajustar a struct).

### 2.4 RPC / quoting em geral
- 🚩 Forks/UniV2 multiplicam as chamadas de quote por par (cada venue extra = +1 quote no fanout +
  +1 resolução no boot). Com até 60 pares derivados, **mais pressão no RPC**. Vigiar rate-limit do
  dRPC/Alchemy; `MIS_MAX_DERIVED_PAIRS` e `ARB_TOP_N` controlam o volume. O resolver já tem retry+backoff.
- 🚩 UniV2 **fee-on-transfer**: a `UniswapV2Lib` usa `swapExactTokensForTokens` (não a variante FoT).
  Tokens FoT vão reverter — o off-chain deve filtrá-los (GoPlus já faz no discovery). Não habilitar venue
  UniV2 pra par com token FoT conhecido.

---

## 3) 🔍 Itens a revisar (código / segurança)

### 3.1 Auth da rota `/api/control` (sensível — dinheiro real)
- 🚩 Hoje o painel é **privado-por-URL** (mesmo modelo do resto do app: RLS read `using(true)`, sem Supabase Auth).
  A rota `/api/control` POST **libera escrita sem auth** a menos que `ZEUS_CONTROL_SECRET` esteja setado
  (aí exige header `x-zeus-control`). **Quem tiver a URL pode ligar/desligar.**
- **Recomendação:** pôr o painel inteiro atrás de auth (Vercel password protection ou Supabase Auth)
  **antes** de operar em mainnet. Expor o secret no browser não resolve (é client-side).
- Mitigação que já existe: o **bot** tem fail-safe + circuit breakers + dupla confirmação na UI; o pior caso
  do toggle é "liga execução", mas os gates do bot (min profit, simulação, MAX_TRADE) seguem barrando trade ruim.

### 3.2 Estado real vs desejado no painel
- O bot reflete o estado real em `/readyz` (`dispatchesPaused`). 🚩 O painel **ainda não lê** esse
  `dispatchesPaused` pra mostrar "desejado vs real" lado a lado — hoje mostra só o desejado (o que o botão pediu).
  Melhoria pendente: a tela Home/Health puxar `/readyz` (ou heartbeat) e alertar se divergir (bot offline, sem SUPABASE_URL).
- 🚩 **Heartbeat dedicado** (`zeus.heartbeat`) **não** foi emitido aqui — ficou pro plano da "cola de webhook"
  (ver topo do arquivo de planos). Por ora o estado real vem só do `/readyz`.

### 3.3 Pricing reaproveitado (conferir no DRY_RUN)
- Slipstream usa a **mesma math da UniV3** (slot0/sqrtPriceX96) e UniV2 usa a do **Aero volatile**
  (getReserves, x*y=k). Está correto teoricamente, mas **conferir no ledger DRY_RUN** que os spots dos novos
  venues batem com o preço real (sem divergência sistemática que indique bug de orientação token0/token1 ou decimals).
- Para UniV2 forço `stable=false` no pricing (pool UniV2 não tem `stable()`); confirmar que nenhum "Aero" real
  está sendo lido como UniV2 por engano (são resolvidos por factories distintas, então não deve ocorrer).

### 3.4 Outros
- 🚩 `desired_mode` na tabela `engine_control` existe mas **o bot ainda não consome** (só lê `execution_enabled`).
  Mudar o modo (dryrun↔mainnet) em runtime fica pra depois — hoje o modo vem do `.env` no boot.
- 🚩 Endereços v8 (split) no `CLAUDE.md` continuam "a atualizar ao redeploy" — atualizar após o deploy dos novos contratos.
- Regra `approvedDexAdapters` segue **sem enforcement on-chain** (documentado em `docs/LOOSE_WIRES.md`) — os novos
  venues entram pela mesma porta; o controle de risco é off-chain (gate/sim) + circuit breakers do contrato.

---

## 3.5) 🛣️ Onda 2 — Curve + Maverick (Humberto faz no PC — NÃO implementado)

> Deixados de fora da onda 1 porque têm **matemática/arquitetura própria** (não dá pra reusar
> UniV2Lib nem a trilha UniV3). Cada um é um adapter novo (lib on-chain + pricing + quoter + fork test).
> **Exigem redeploy** (novo branch no `_executeSwaps`). Notas de design pra adiantar:

### Curve (StableSwap) — `DexType.Curve=3` (enum JÁ reservado)
- **On-chain (`CurveLib.sol`):** Curve é **pool-based** (não router). O `SwapStep.router` aponta pro
  **pool**. Swap = `exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)` (pools stable antigos) ou
  `exchange(uint256 i, uint256 j, ...)` (crypto/NG) — **o selector varia por tipo de pool** (plain/meta/ng).
  Começar **só com plain stable** (USDC/USDT/USDbC). `extraData = abi.encode(int128 i, int128 j)` (índices
  dos tokens no pool). `approve` no pool.
- **Off-chain:** NÃO reimplementar o invariant StableSwap — cotar via `get_dy(i, j, dx)` (view) no
  próprio pool. Pricing spot = probe `get_dy` de 1 unidade (igual ao Trader Joe `getSwapOut`).
- **Discovery:** Curve registry/MetaRegistry via AddressProvider `0x0000000022D53366457F9d5E68Ec105046FC4383`
  (canônico multi-chain) → resolve pools por par. **🚩 verificar na Base.**
- **Scanner:** novo `PoolDex 'curve'`; rota de pricing = probe get_dy (espelhar a trilha do traderjoe).
- **Cuidado:** índices i/j e tipo de pool são por-pool → cachear no resolve (como fee/tickSpacing).

### Maverick (dynamic distribution AMM) — `DexType.Maverick=6` (APPEND ao enum, não reordenar)
- **On-chain (`MaverickLib.sol`):** Maverick V2 tem **Router** com `exactInputSingle`. Bins se movem →
  não dá pra precificar por reserves estáticas. `extraData = abi.encode(address pool)` (Maverick é
  pool-específico). `router` = Maverick Router; `approve` no router.
- **Off-chain:** cotar via **Maverick Quoter** (`calculateSwap`/`quoteExactInputSingle`) — não reimplementar
  a distribuição. Pricing spot = quote de 1 unidade.
- **Discovery:** Factory/PoolLens do Maverick V2 na Base → resolve pool por par. **🚩 pegar endereços nos docs.**
- **Scanner:** novo `PoolDex 'maverick'`; pricing via quoter (não via slot0/reserves).
- Adicionar `Maverick=6` no enum Solidity **e** no mirror TS (`dex-adapters/src/types.ts`) — manter sincronizados.

### Onde plugar (mesma espinha da onda 1)
1. Enum: `contracts/src/interfaces/IZeusExecutor.sol` + `packages/dex-adapters/src/types.ts`.
2. Lib + branch em `_executeSwaps` (`ZeusArbExecutor.sol`). **Medir EIP-170 a cada lib** (folga atual 8.8 KB).
3. Config: campos em `chain-config/src/{types,base}.ts` (estilo lista, como `univ2Dexes`).
4. Adapter off-chain: `dex-adapters/src/{curve,maverick}/` (resolver pool + quote + pricing).
5. Scanner: `PoolDex` + branches em `marketInefficiencyScanner.ts` + `poolGroups.ts` + `flashEstimator.ts`.
6. Execução: `quoteFanout.ts` + `txBuilder.ts` (`resolveRouter`) + `groupToTargetPair`.
7. Fork test em `test/fork/` (dobra como verificação on-chain dos endereços).

---

## 4) ✔️ O que já está verificado (não precisa refazer)
- `forge` unit **78/79** (1 skip — baseline intacto após enum+dispatch novos).
- Novo fork test compila e dá **skip** sem RPC (roda no CI com `BASE_RPC_HTTP`).
- `pnpm typecheck` **13/13** + frontend typecheck ✓.
- vitest sem regressão: execution-utils **336/336**, strategy, **mis-scanner 23/24** (engineControl fail-safe 7/7 + separação de venues).
- EIP-170 medido (+949 B, 8.8 KB de folga).

---

## 5) Arquivos-chave (pra navegação rápida)
- Contratos: `contracts/src/libraries/{SlipstreamLib,UniswapV2Lib}.sol`, `src/ZeusArbExecutor.sol` (`_executeSwaps`), `src/interfaces/IZeusExecutor.sol` (enum), `test/fork/ZeusArbExecutorDex.fork.t.sol`.
- Config: `packages/chain-config/src/{base,types,target-pairs}.ts`.
- Adapters: `packages/dex-adapters/src/{slipstream,uniswap-v2}/quoter.ts`, `pricing/poolStateReader.ts`.
- Scanner/exec: `apps/mis-scanner/src/{poolGroups,flashEstimator,engineControl,config,index}.ts`, `execution/{arbOpportunity,arbDispatcher}.ts`.
- Strategy: `packages/strategy/src/opportunities/quoteFanout.ts`, `executor/txBuilder.ts`.
- Frontend: `frontend/app/api/control/route.ts`, `frontend/components/screens/Settings.tsx`, `frontend/supabase/schema.sql`.
- Design M1/M3: `docs/REMOTE_CONTROL.md` (branch `claude/motor-remote-control`).
