# CONTRACTS — ZEUS EVM

Especificação detalhada dos smart contracts do bot. Incluindo padrões, audit pipeline e knowledge limits da IA.

---

> ## 🔄 ESTADO ATUAL (2026-06-17) — SPLIT v8 em 4 contratos
>
> O `ZeusExecutor` monolítico descrito abaixo **foi dividido em 4 contratos (v8)** pra respeitar o limite de
> tamanho do Ethereum (EIP-170, 24KB). A lógica de cada função continua igual — só mudou onde mora:
>
> | Contrato | Funções | Herança |
> |---|---|---|
> | **ZeusArbExecutor** | `executeArbitrage` (wallet) · `executeFlashloanArbitrage` · `executeFlashloanBackrun` (com bribe) + `executeOperation` | Ownable2Step + ReentrancyGuard |
> | **ZeusLiquidator** | `executeLiquidation` (Aave) · `executeCompoundLiquidation` · `executeMorphoLiquidation` (+ variantes `*WithBribe`) + `executeOperation` | Ownable2Step + ReentrancyGuard |
> | **ZeusMoonwellLiquidator** | `executeMoonwellLiquidation` (fork Compound V2 — não usa BribeManager) | Ownable2Step + ReentrancyGuard |
> | **BribeManager** | `pay()` — gorjeta MEV ao block.coinbase + slippage floor (compartilhado) | ReentrancyGuard |
>
> Mudanças vs. o texto antigo: **Pausable removido** (kill switch `_killed` é o circuit breaker primário) ·
> **flashloan multi-fonte** (`FlashSource` enum: Aave 0,05% · Morpho 0% · Balancer 0%) ·
> **SwapStep[] multi-hop** (N steps → suporta triangular) · **Morpho é função do ZeusLiquidator, não contrato** ·
> **Moonwell é contrato próprio** · cobertura agora é **5 protocolos** (Aave/Compound/Morpho/Seamless/Moonwell).
> Validado: **115 funções Foundry em 9 arquivos** (4 unit + 5 fork via Alchemy).
> A spec abaixo descreve a lógica/funções (ainda fiel) usando o nome antigo `ZeusExecutor`.

## 🧭 Visão geral

ZEUS EVM tem **4 contratos v8** (ZeusArbExecutor + ZeusLiquidator + ZeusMoonwellLiquidator + BribeManager) + libraries-adapter inline por DEX (UniV3, Aerodrome, **UniswapV2Lib, SlipstreamLib, PancakeV3Lib**). Toda a lógica hot-path passa por esses contratos atômicos.

> **🆕 2026-06-24 — v9: whitelist de routers + cobertura de fork ampliada (NÃO redeployado):**
> - **Whitelist on-chain de routers** nos 3 contratos: `mapping(address=>bool) approvedRouter` público + `setApprovedRouter(router,bool) onlyOwner` + check **default-deny** `if (!approvedRouter[step.router]) revert RouterNotApproved()` no `_executeSwaps`. `Deploy.s.sol` aprova o UniV3 SwapRouter; demais via runbook. EIP-170 ok (ZeusLiquidator 21.403 B / folga 3.173 B).
> - **Cobertura ABI on-chain ampliada (fork tests Alchemy archive):** novos `ZeusMoonwellLiquidator.fork` (liquidateBorrow), `ZeusCompoundLiquidator.fork` (Comet.absorb), `ZeusMorphoLiquidator.fork` (Morpho.liquidate → `"position is healthy"`) + `ZeusArbExecutor.fork` com flashSource Morpho/Balancer. **`forge test` 147/0.** Provam ABI/wiring, não lucro (round-trips) — exceto Aave/Dex (lucro end-to-end).
> - ⚠️ **A Sepolia ainda roda v8** (cast: `approvedRouter` reverte). **Falta redeploy v9** + `revive()`/`setOperator()` no Moonwell (`isKilled()=true`). Runbook em `docs/MAINNET_READINESS_MOTOR1.md`.
>
> **🆕 2026-06-23 — adapters de DEX (Motor 2) + redeploy testnet:**
> - **`DexType`** ganhou `Slipstream=5` e `PancakeV3=6` (append; fonte única em `shared-types`, espelho no Solidity, guarda no pin test `dex-adapters/src/dexType.pin.test.ts`).
> - **`PancakeV3Lib.sol`** (novo) — `exactInputSingle` COM `deadline` na struct. Pancake V3 **e Sushi V3 na Base** (verificado on-chain) usam essa trilha; UniV3 canônico/Sushi-fora-da-Base seguem `UniswapV3Lib` (sem deadline).
> - **`UniswapV2Lib.sol`** + **`SlipstreamLib.sol`** (Aerodrome CL) — adapters dos forks UniV2 e do Slipstream.
> - EIP-170: ZeusArbExecutor **16.223 B** (folga 8.353 B).
> - **Redeploy Base Sepolia v8 (2026-06-23, com os adapters):** BribeManager `0xe0B6A6840d1f011F27Ec63eb3390D0d7E0904795` · ZeusLiquidator `0x8E769a56F0f3fA7e7410fE5955D94E9dE458193D` · ZeusArbExecutor `0x0156Aa6729891103Cc22b1e14c5E1e5338E6ab4A` · ZeusMoonwellLiquidator `0x3A34EcDD1A9a53d5799fF0f4cB479FF2963F3dA3`. Owner=deployer `0xE060…cBB4`. Liquidator+ArbExecutor já com `revive()`+`setOperator`. **Moonwell ainda com kill switch ativo.** **Ainda NÃO mainnet.**

```
┌─────────────────────┐  ┌─────────────────────┐  ┌──────────────────────┐
│  ZeusArbExecutor    │  │   ZeusLiquidator    │  │ ZeusMoonwellLiquidator│
│  motores 1+3        │  │   liquidações       │  │  Moonwell (Comp V2)  │
│  executeArbitrage   │  │   Aave/Compound/    │  │  executeMoonwell-    │
│  executeFlashloanArb│  │   Morpho (+WithBribe│  │    Liquidation       │
│  executeFlashloan-  │  │   variants)         │  │                      │
│    Backrun          │  │   + executeOperation│  │  + executeOperation  │
│  + executeOperation │  │                     │  │                      │
└──────────┬──────────┘  └─────────┬───────────┘  └──────────────────────┘
           │                       │                  variantes *WithBribe
           │                       └──────────┬───────────────┘
           ▼                                  ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│ DEX libs (inline adapter)│      │   BribeManager.pay()     │
│  UniswapV3Lib            │      │  bribe ao block.coinbase │
│  AerodromeLib            │      │  + slippage floor (H-01) │
│  (DexType: V2/V3/Aero/   │      └──────────────────────────┘
│   Curve*/Balancer*)      │
└──────────────────────────┘      Flashloan (FlashSource enum):
                                   Aave 0,05% · Morpho 0% · Balancer 0%
(* = stub / Fase futura)
```

---

## ⛓️ Contratos

### 1. `ZeusArbExecutor.sol` — Motores 1 (arb wallet) + 3 (backrun)

**Propósito:** Orquestrar arbitragens atômicas (capital próprio + flashloan + backrun com bribe).

**Inheritance:**
- `Ownable2Step` (OpenZeppelin) — propriedade transferível com confirmação
- `ReentrancyGuard` (OpenZeppelin) — proteção contra reentrância
- _(Pausable removido — `_killed` é o circuit breaker primário)_

**Storage (pós Audit Pass 2):**
```solidity
uint256 public maxTradeWei;                     // circuit breaker fallback global
mapping(address => uint256) private _maxTradePerToken;  // H-02 fix: cap específico por token
mapping(address => bool) private _operators;    // wallets autorizadas além do owner
bool private _killed;                            // kill switch (deploya killed=true)
address public weth;                             // mutável via setWeth
address public uniV3SwapRouter;                  // mutável via setUniV3SwapRouter
```

**Funções principais:**

```solidity
// ─── Motor 1: Capital próprio ───
function executeArbitrage(ArbitrageParams calldata params)
    external onlyOperator whenAlive nonReentrant;

// ─── Motor 1/3: Flashloan arbitrage (3 fontes via FlashSource enum) ───
function executeFlashloanArbitrage(
    FlashSource src,                 // Aave (0,05%) | Morpho (0%) | Balancer (0%)
    address flashloanAsset,
    uint256 flashloanAmount,
    ArbitrageParams calldata params
) external onlyOperator whenAlive nonReentrant;

// ─── Motor 3: Backrun de dislocação (com bribe ao block.coinbase) ───
function executeFlashloanBackrun(/* ... + BribeConfig */)
    external onlyOperator whenAlive nonReentrant;

// Callback flashloan — repago varia por fonte:
//   Aave: approve(pool, amount+premium) · Morpho: approve(singleton, amount)
//   Balancer: transfer(vault, amount+premium)
function executeOperation(
    address asset, uint256 amount, uint256 premium,
    address initiator, bytes calldata params
) external returns (bool);
// + onMorphoFlashLoan / receiveFlashLoan (callbacks Morpho/Balancer)

// ─── Admin (só owner) ───
function kill() external onlyOwner;                                // só liga (idempotente)
function setMaxTradeWei(uint256 newMax) external onlyOwner;
function setMaxTradePerToken(address token, uint256 newMax) external onlyOwner;  // H-02 fix
function setOperator(address op, bool allowed) external onlyOwner;
function rescueToken(address token, uint256 amount, address to) external onlyOwner;
function setWeth(address newWeth) external onlyOwner;
function setUniV3SwapRouter(address newRouter) external onlyOwner;
```

**Multi-hop / triangular:** `params.steps` é um `SwapStep[]` dinâmico de N hops. Cada step define
`DexType` (UniswapV2 / UniswapV3 / Aerodrome / Curve* / Balancer*) e roteia via library inline.
`amountIn=0` num step significa "usar saldo atual do contrato" (encadeamento). Isso cobre triangular.

**Circuit breakers:** `_killed` (kill switch) + `maxTradeWei` global + `_maxTradePerToken`
(H-02 fix, cap por token) + `params.minProfitWei` (revert se profit < mínimo).

---

### 1b. `ZeusLiquidator.sol` — Liquidações Aave / Compound / Morpho

```solidity
function executeLiquidation(LiquidationParams calldata params) ...           // Aave V3 (+ Seamless fork)
function executeCompoundLiquidation(CompoundLiquidationParams calldata p) ... // Compound III (Comet)
function executeMorphoLiquidation(MorphoLiquidationParams calldata p) ...      // Morpho Blue
// variantes com bribe (chamam BribeManager.pay()):
function executeLiquidationWithBribe(LiquidationParams p, BribeConfig b) ...
function executeCompoundLiquidationWithBribe(...) ...
function executeMorphoLiquidationWithBribe(...) ...
function executeOperation(...) external returns (bool);  // callback flashloan
```
Mesma herança (Ownable2Step + ReentrancyGuard) e mesmos circuit breakers do ZeusArbExecutor.

### 1c. `ZeusMoonwellLiquidator.sol` — Moonwell (fork Compound V2)

```solidity
function executeMoonwellLiquidation(MoonwellLiquidationParams calldata params) ...
function executeOperation(...) external returns (bool);
```
Contrato próprio (Moonwell tem API de cToken estilo Compound V2). **Não usa BribeManager.**

### 1d. `BribeManager.sol` — Bribe MEV (compartilhado)

```solidity
function pay(BribeConfig calldata bribe, ...) external nonReentrant;  // transfere ao block.coinbase
function validateConfig(BribeConfig calldata bribe) external pure;
```
Herança: só `ReentrancyGuard`. **Slippage floor (Audit Pass 4 H-01):** caller DEVE setar
`minBribeWei` (~90% do quote esperado) pra proteger contra slippage no swap que financia a bribe.

**Eventos (todos com profit em wei do asset do retorno):**
- `ArbitrageExecuted(initiator, profitToken, profit, swapsCount)`
- `FlashloanArbitrageExecuted(...)` / `FlashloanBackrunExecuted(...)`
- `LiquidationExecuted(...)` / `CompoundLiquidationExecuted(...)` / `MorphoLiquidationExecuted(...)`
- `MoonwellLiquidationExecuted(...)` · `BribePaid(...)`
- `MaxTradePerTokenUpdated(token, oldValue, newValue)` — H-02 fix
- `Killed()` / `OperatorSet()` / `TokenRescued()`

**Custom errors (gas-efficient):**
- `NotAuthorized()` — operator/owner check failed
- `BotKilled()` — kill switch ativo
- `InsufficientProfit(uint256 actual, uint256 required)` — minProfitWei não atingido
- `SwapFailed(uint256 stepIndex)`
- `InvalidDexType(uint8 dexType)`
- `FlashloanRepayShortfall(uint256 available, uint256 required)`
- `TradeTooLarge(uint256 amount, uint256 max)` — cap per-token excedido
- `EmptySteps()`
- `InvalidCaller()` — callback de flashloan ou initiator inválido

---

## 🛡️ Security Audit Pass 1 + Pass 2 (2026-05-25)

Auditoria interna realizada sob lente AppSec (Jim Manico) + vuln assessment (Omar Santos).

**Findings:** 0 Critical · **2 HIGH** · **4 MEDIUM** · 6 LOW · 6 INFO

**Todos os HIGH e MEDIUM corrigidos.** 11 testes adversariais adicionados (`ZeusExecutor.fixes.t.sol`).

### H-01 — Approval Morpho infinita (CORRIGIDO)

**Antes:**
```solidity
IERC20(mp.loanToken).forceApprove(mp.morpho, type(uint256).max);
```
Approval infinita persistia post-tx. Operator malicioso poderia passar `mp.morpho` malicioso e drenar futuras balances.

**Depois:**
```solidity
IERC20(mp.loanToken).forceApprove(mp.morpho, amount);    // bound ao flashloan
IMorpho(mp.morpho).liquidate(...);
IERC20(mp.loanToken).forceApprove(mp.morpho, 0);          // reset post-call
```

### H-02 — Circuit breaker quebrado pra non-18-decimal tokens (CORRIGIDO)

**Antes:** `maxTradeWei` global aplicado uniformemente — pra USDC (6 dec) o cap era efetivamente $100 trilhões.

**Depois:** mapping `_maxTradePerToken` + helper `getMaxTradeFor(asset)`. Fallback global preservado pra compat.

### M-01 — Pre-existing balance vaza pro profit (CORRIGIDO)

**Antes:** profit calculado como `balance − amountOwed`, incluindo qualquer saldo pré-existente do debt asset.

**Depois:** snapshot `balanceBefore` capturado no entrypoint, encodado nos params do flashloan, descontado no profit calc dos handlers. Aplicado nas 3 funções de liquidação.

### M-02 — Mistura semântica `seizedAssets`/`repaidShares` (CORRIGIDO)

**Antes:** Morpho liquidation usava `seizedAssets` (wei do collateralToken) como flashloan amount (wei do loanToken). Footgun.

**Depois:** novo campo explícito `MorphoLiquidationParams.flashloanAmount` (wei do loanToken). Caller calcula off-chain via simulação `Morpho.liquidate`.

### LOW + INFO findings

Documentados mas não bloqueantes pra mainnet:
- L-01 ETH preso (sem rescueETH) — não crítico em flashloan-only
- L-02 setMaxTradeWei sem timelock — owner power, OK em multisig
- L-03 Pause + Kill duplication — defensivo
- L-04 Validação `address(0)` inconsistente — endurecer antes de mainnet
- L-05 COMP rewards acumulam — sweep periódico via rescueToken
- L-06 Eventos vazam estratégia em mempool — usar private mempool

**Padrões de segurança aplicados:**

| Pattern | Implementação |
|---|---|
| Reentrancy guard | `nonReentrant` em todas as state-changing externas |
| Checks-effects-interactions | Validações primeiro, side effects no fim |
| Ownership 2-step | `Ownable2Step` evita perda acidental |
| Kill switch | `_killed` (deploya `killed=true`) — circuit breaker primário, Pausable removido |
| DexType allowlist | `DexType` enum roteia só pra libraries conhecidas; `InvalidDexType` reverte o resto |
| MaxTradeWei + per-token | Cap global + `_maxTradePerToken` (H-02) no entry point |
| Bribe slippage floor | `minBribeWei` no BribeManager (Audit Pass 4 H-01) |
| Profit obrigatório | `require(profit >= minProfitWei)` ou revert |
| Eventos completos | Toda operação emit pra auditabilidade |

---

### 2. DEX adapters — libraries inline (não contratos separados)

**Decisão:** os adapters não são contratos com interface `IDexAdapter`; são **libraries inline**
(`UniswapV3Lib`, `AerodromeLib`) embarcadas nos executores. Cada step de swap carrega um `DexType`
e a library faz o roteamento. Sem chamadas externas a "adapter contracts" → menos gas, menos superfície.

`enum DexType { UniswapV2, UniswapV3, Aerodrome, Curve, Balancer }` — Curve e Balancer hoje são
**stubs** (revertem com `InvalidDexType` até implementação futura).

#### UniswapV3Lib
- Usa `ISwapRouter.exactInputSingle()` (SwapRouter02)
- Fee tiers 100 (0.01%), 500 (0.05%), 3000 (0.3%), 10000 (1%) via `extraData`
- Approve via `forceApprove` (SafeERC20)

#### AerodromeLib
- Pools `stable` (curva ve(3,3)) e `volatile` (curva x*y=k)
- Decode `extraData` pra tipo de pool + factory
- Usa `IRouter.swapExactTokensForTokens()`

> Off-chain o pricing tem equivalentes em `@zeus-evm/dex-adapters` (UniV3 + Aerodrome + Velodrome
> + Trader Joe LB pra Avalanche). On-chain só UniV3 + Aerodrome estão ativos hoje.

---

### 3. Liquidator — ZeusLiquidator + ZeusMoonwellLiquidator

**Propósito:** Executar liquidations Aave V3 (+ Seamless fork) / Compound III / Morpho Blue / Moonwell via flashloan.

Cada protocolo tem sua própria struct de params (`LiquidationParams`, `CompoundLiquidationParams`,
`MorphoLiquidationParams`, `MoonwellLiquidationParams`) com o `flashloanAmount` explícito (M-02 fix
pro Morpho) e `minProfitWei`. A fonte do flashloan é escolhida via `FlashSource`.

Fluxo interno (genérico):
1. Flashloan `debtAsset` na quantia necessária (Aave / Morpho / Balancer)
2. Callback chama `liquidationCall` / `absorb+buyCollateral` / `liquidate` / `liquidateBorrow` no protocol
3. Recebe `collateralAsset` + bonus 5-10%
4. Swap collateral → debt asset (pra repagar flashloan, via UniV3Lib/AerodromeLib)
5. Profit residual fica no executor → owner
6. Variantes `*WithBribe` pagam parte do profit ao `block.coinbase` via `BribeManager.pay()` (OEV)

---

## 🛡️ Audit Pipeline

### Pre-Foundry build (automatizado)
1. **Slither** (`slither contracts/`) — static analysis
2. **Mythril** (`myth analyze contracts/src/ZeusArbExecutor.sol`) — symbolic execution (rodar pros 4)
3. **Forge fmt** — formatação consistente

### Foundry tests
4. **Unit tests** — coverage 95%+ nos 4 contratos (**115 funções em 9 arquivos**: 4 unit + 5 fork)
5. **Fuzz tests** — `forge test --fuzz-runs 100000`
6. **Invariant tests** — propriedades globais sempre verdade
7. **Fork tests** — `vm.createFork(BASE_RPC)` testando contra DEXs reais

### Manual review interna
8. **Walkthrough** seguindo:
   - [Trail of Bits Building Secure Contracts](https://secure-contracts.com/)
   - [SWC Registry](https://swcregistry.io/) — verificar SWC-100 a SWC-136
   - [Solidity Patterns](https://fravoll.github.io/solidity-patterns/) — padrões e anti-padrões

### Pre-mainnet (Fase 7+)
9. **Testnet Base Sepolia 2 semanas** — comportamento estável
10. **Capital pequeno mainnet 2-4 semanas** — observação
11. **Audit externo** (Fase 8) — Certik ou similar
12. **Bug bounty Immunefi** — pool US$ 5-10k por 30 dias

### Pós-deploy contínuo
13. **Tenderly alerts** — eventos anormais
14. **Forta Network agents** (gratuito)
15. **OpenZeppelin Defender Sentinel** (paid)

---

## 🚀 Deploy Pipeline

### Comandos Foundry

```bash
# Build
forge build

# Test
forge test -vvv
forge test --fuzz-runs 100000
forge test --match-path test/fork/*  # só fork tests

# Coverage
forge coverage --report lcov

# Static analysis
slither .
myth analyze src/ZeusArbExecutor.sol   # repetir pros 4 contratos

# Deploy testnet
forge script script/Deploy.s.sol \
    --rpc-url base_sepolia \
    --broadcast \
    --verify \
    --etherscan-api-key $BASESCAN_API_KEY

# Deploy mainnet (após audit + multisig configurado)
forge script script/Deploy.s.sol \
    --rpc-url base \
    --broadcast \
    --verify \
    --account safe_signer  # ledger ou multisig
```

### Governance pós-deploy

| Ação | Quem | Como |
|---|---|---|
| Kill switch | Owner (multisig 2-de-3) | `kill()` (por contrato — idempotente, só liga) |
| Mudar max trade | Owner (multisig 2-de-3) | `setMaxTradeWei()` / `setMaxTradePerToken()` |
| Adicionar operator | Owner (multisig 2-de-3) | `setOperator()` |
| Trocar WETH/router | Owner (multisig 2-de-3) | `setWeth()` / `setUniV3SwapRouter()` |
| Rescue stuck tokens | Owner (multisig 2-de-3) | `rescueToken()` |
| Upgrade contract | **Não há** — deploy novo (intencional, sem proxy) |

**Decisão de design:** **NÃO usar proxy upgradeable.** Em caso de bug crítico:
1. Owner chama `kill()` no(s) contrato(s) afetado(s)
2. Owner chama `rescueToken()` pra recuperar fundos
3. Deploya novo contrato (ZeusArbExecutor / ZeusLiquidator / etc.)
4. Atualiza os apps off-chain pra usar o novo address

Trade-off aceito: menos flexibilidade vs menos superfície de ataque (proxies têm CVEs documentadas).

---

## 🧠 Knowledge Limits da IA (Claude)

Transparência sobre meus limites pra cada componente:

| Área | Confiança | Mitigation |
|---|---|---|
| **Contratos v8 com Ownable2Step + ReentrancyGuard (kill switch `_killed`)** | 🟢 Alto | Posso entregar direto, base OpenZeppelin |
| **Adapter Uniswap V3 (lib inline)** | 🟢 Alto | Padrão bem documentado, posso entregar |
| **Adapter Aerodrome (lib inline)** | 🟡 Médio | Aerodrome tem nuances (ve(3,3), pools stable/volatile). Posso entregar mas recomendo conferir comportamento real em fork |
| **Callback Aave V3 Flashloan** | 🟢 Alto | Padrão IFlashLoanReceiver bem conhecido |
| **Flashloan Morpho / Balancer (0% fee)** | 🟡 Médio | Callbacks e estilo de repago diferem do Aave; validar em fork (`MotorsProfit.fork`) |
| **Liquidations Aave V3 (+ Seamless fork)** | 🟢 Alto | `liquidationCall` é direto |
| **Liquidations Compound III** | 🟡 Médio | Compound V3 tem API diferente do V2, menos exemplos |
| **Liquidations Morpho Blue** | 🟡 Médio | Morpho tem variantes (Aave/Compound/Blue), API menos uniforme |
| **Liquidations Moonwell (fork Compound V2)** | 🟡 Médio | cToken API estilo Comp V2 (`liquidateBorrow`); contrato próprio |
| **Bribe / OEV (BribeManager, coinbase transfer)** | 🟡 Médio | slippage floor crítico (`minBribeWei`); validar em fork |
| **Detector TS com viem** | 🟢 Alto | Posso entregar direto |
| **Mempool monitoring otimizado** | 🟡 Médio | Conheço Alchemy/Blocknative APIs, mas otimização extrema requer iteração |
| **MEV Bundle submission (Flashbots)** | 🟡 Médio | Conheço, mas não usaremos em Base (sem Flashbots equivalente robusto ainda) |
| **Gas optimization extremo (Yul/assembly)** | 🔴 Baixo | Pra otimização nível Seaport/Uniswap V3 precisa de humano dedicado |
| **Audit profissional** | 🔴 Não substituo | Sempre audit externo antes de capital alto |
| **Detecção de exploits zero-day** | 🔴 Não fazemos | Bug bounty + Tenderly monitoring |

### Como expandir minhas capacidades nas áreas 🟡 🔴

Salvar em `docs/refs/`:
- `aerodrome-deep.md` — docs Velodrome/Aerodrome + análise de pools
- `compound-v3-api.md` — diferenças com V2, exemplos de liquidation
- `morpho-blue.md` — API atual do Morpho Blue
- `gas-optimization.md` — Yul cheatsheet, comparações Seaport/Uniswap V3
- `mev-base.md` — landscape MEV em Base (Flashbots? alternative?)
- `audit-mindset.md` — Trail of Bits + Code4rena top findings

Quando esses MDs existirem, atualizar `CLAUDE.md`:
> "Ao trabalhar em adapters/strategies, ler primeiro `docs/refs/*.md`"

---

## 📂 Arquivos relacionados

- [README.md](./README.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [TODO.md](./TODO.md) — Fases detalhadas
- [CLAUDE.md](./CLAUDE.md) — pacote portátil pra IA
- [CONTEXT.md](./CONTEXT.md) — princípios de risco
