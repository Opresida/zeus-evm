# CONTRACTS — ZEUS EVM

Especificação detalhada dos smart contracts do bot. Incluindo padrões, audit pipeline e knowledge limits da IA.

---

> ## 🔄 ESTADO ATUAL (2026-05-29) — SPLIT v8 em 4 contratos
>
> O `ZeusExecutor` monolítico descrito abaixo **foi dividido em 4 contratos (v8)** pra respeitar o limite de
> tamanho do Ethereum (EIP-170, 24KB). A lógica de cada função continua igual — só mudou onde mora:
>
> | Contrato | Funções | Herança |
> |---|---|---|
> | **BribeManager** | `pay()` — gorjeta MEV ao block.coinbase (compartilhado) | ReentrancyGuard |
> | **ZeusLiquidator** | `executeLiquidation` (Aave) · `executeCompoundLiquidation` · `executeMorphoLiquidation` (+ variantes WithBribe) | Ownable2Step + ReentrancyGuard |
> | **ZeusArbExecutor** | `executeArbitrage` · `executeFlashloanArbitrage` · `executeFlashloanBackrun` + `executeOperation` | Ownable2Step + ReentrancyGuard |
> | **ZeusMoonwellLiquidator** | liquidation Moonwell (fork Compound V2 — não usa BribeManager) | Ownable2Step + ReentrancyGuard |
>
> Mudanças vs. o texto antigo: **Pausable removido** (kill switch `_killed` é o circuit breaker primário) ·
> **Morpho é função do ZeusLiquidator, não contrato** · **Moonwell é contrato próprio** · cobertura agora é
> **5 protocolos** (Aave/Compound/Morpho/Seamless/Moonwell). Validado: 67 unit + 34 fork tests (Alchemy).
> A spec abaixo descreve a lógica/funções (ainda fiel) usando o nome antigo `ZeusExecutor`.

## 🧭 Visão geral

ZEUS EVM tem **4 contratos v8** (BribeManager + ZeusLiquidator + ZeusArbExecutor + ZeusMoonwellLiquidator) + adapters modulares por DEX (UniV3, Aerodrome, Trader Joe LB). Toda a lógica hot-path passa por esses contratos atômicos.

```
┌──────────────────────────────────────────────────────────────┐
│                    ZeusExecutor.sol                           │
│  (Entry point único — owner-controlled, kill switch)          │
└──────────────────────────────────────────────────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌──────────────┐    ┌─────────────────────┐    ┌──────────────┐
│ DEX adapters │    │ Flashloan callback  │    │ Liquidator   │
│              │    │ (Aave V3)           │    │ (Aave/Comp)  │
│ UniV3        │    │                     │    │              │
│ Aerodrome    │    │ executeOperation()  │    │              │
│ Curve*       │    │                     │    │              │
│ Balancer*    │    │                     │    │              │
└──────────────┘    └─────────────────────┘    └──────────────┘

(* = Fase futura)
```

---

## ⛓️ Contratos

### 1. `ZeusExecutor.sol` — Entry point principal

**Propósito:** Orquestrar arbitragens atômicas (wallet + flashloan + liquidations).

**Inheritance:**
- `Ownable2Step` (OpenZeppelin) — propriedade transferível com confirmação
- `Pausable` (OpenZeppelin) — kill switch global
- `ReentrancyGuard` (OpenZeppelin) — proteção contra reentrância

**Storage (atualizado 2026-05-25 pós Audit Pass 2):**
```solidity
address public immutable AAVE_V3_POOL;          // imutável após deploy
uint256 public maxTradeWei;                     // circuit breaker fallback global
mapping(address => uint256) private _maxTradePerToken;  // H-02 fix: cap específico por token
mapping(address => bool) private _operators;    // wallets autorizadas além do owner
bool private _killed;                            // override do Pausable pra UX
```

**Funções principais (v6 — Aave + Compound + Morpho):**

```solidity
// ─── Modalidade 1: Capital próprio ───
function executeArbitrage(ArbitrageParams calldata params)
    external onlyOperator whenNotPaused whenAlive nonReentrant;

// ─── Modalidade 2: Flashloan arbitrage ───
function executeFlashloanArbitrage(
    address flashloanAsset,
    uint256 flashloanAmount,
    ArbitrageParams calldata params
) external onlyOperator whenNotPaused whenAlive nonReentrant;

// ─── Modalidade 3: Liquidação Aave V3 ───
function executeLiquidation(LiquidationParams calldata params)
    external onlyOperator whenNotPaused whenAlive nonReentrant;

// ─── Modalidade 4: Liquidação Compound III (Comet) ───
function executeCompoundLiquidation(CompoundLiquidationParams calldata params)
    external onlyOperator whenNotPaused whenAlive nonReentrant;

// ─── Modalidade 5: Liquidação Morpho Blue ───
function executeMorphoLiquidation(MorphoLiquidationParams calldata params)
    external onlyOperator whenNotPaused whenAlive nonReentrant;

// Callback Aave V3 — só AAVE_V3_POOL pode chamar, initiator deve ser this
function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address initiator,
    bytes calldata params
) external returns (bool);

// ─── Admin (só owner) ───
function kill() external onlyOwner;
function revive() external onlyOwner;
function setMaxTradeWei(uint256 newMax) external onlyOwner;
function setMaxTradePerToken(address token, uint256 newMax) external onlyOwner;  // H-02 fix
function getMaxTradeFor(address token) external view returns (uint256);          // H-02 fix
function setOperator(address op, bool allowed) external onlyOwner;
function rescueToken(address token, uint256 amount, address to) external onlyOwner;
function pause() external onlyOwner;
function unpause() external onlyOwner;
```

**Eventos (todos com profit em wei do asset do retorno):**
- `ArbitrageExecuted(initiator, profitToken, profit, swapsCount)`
- `FlashloanArbitrageExecuted(initiator, flashloanAsset, flashloanAmount, flashloanFee, profitToken, profit)`
- `LiquidationExecuted(initiator, user, collateralAsset, debtAsset, debtCovered, collateralReceived, profit)`
- `CompoundLiquidationExecuted(initiator, comet, borrower, collateralAsset, baseAmount, collateralReceived, profit)`
- `MorphoLiquidationExecuted(initiator, borrower, collateralToken, loanToken, assetsLiquidated, collateralReceived, profit)`
- `MaxTradePerTokenUpdated(token, oldValue, newValue)` — H-02 fix
- `Killed()` / `Revived()` / `OperatorSet()` / `TokenRescued()`

**Custom errors (gas-efficient):**
- `NotAuthorized()` — operator/owner check failed
- `BotKilled()` — kill switch ativo
- `InsufficientProfit(uint256 actual, uint256 required)` — minProfitWei não atingido
- `SwapFailed(uint256 stepIndex)`
- `InvalidDexType(uint8 dexType)`
- `FlashloanRepayShortfall(uint256 available, uint256 required)`
- `TradeTooLarge(uint256 amount, uint256 max)` — cap per-token excedido
- `EmptySteps()`
- `InvalidCaller()` — Aave callback ou initiator inválido

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
| Pausable | Kill switch testado mensalmente |
| Approved adapters | Mapping `approvedDexAdapters` previne swap em adapter desconhecido |
| MaxTradeWei | Cap absoluto no entry point |
| Profit obrigatório | `require(profit >= minProfitWei)` ou revert |
| Eventos completos | Toda operação emit pra auditabilidade |

---

### 2. Adapters DEX

**Propósito:** Cada adapter expõe `swap(SwapStep)` retornando o valor de output.

**Interface comum (`IDexAdapter.sol`):**
```solidity
interface IDexAdapter {
    /// @notice Executa swap único usando este DEX
    /// @param step parâmetros do swap codificados
    /// @return amountOut quanto recebemos do tokenOut
    function swap(SwapStep calldata step) external returns (uint256 amountOut);

    /// @notice Calcula amountOut esperado sem executar (view)
    function quote(SwapStep calldata step) external view returns (uint256);
}
```

#### UniswapV3Adapter.sol
- Usa `ISwapRouter.exactInputSingle()`
- Suporta fee tiers 100 (0.01%), 500 (0.05%), 3000 (0.3%), 10000 (1%)
- Decode `extraData` pra fee tier
- Approve via `forceApprove` (SafeERC20)

#### AerodromeAdapter.sol
- Suporta pools `stable` (curva ve(3,3)) e `volatile` (curva x*y=k)
- Decode `extraData` pra tipo de pool + factory
- Usa `IRouter.swapExactTokensForTokens()`

#### Adapters futuros (Fase 9+)
- CurveAdapter.sol (StableSwap)
- BalancerAdapter.sol (Weighted + Composable Stable)
- SushiAdapter.sol (V2 + V3)

---

### 3. Liquidator interno

**Propósito:** Executar liquidations Aave V3 / Compound III / Morpho via flashloan.

```solidity
struct LiquidationParams {
    uint8 protocol;          // 0=AaveV3, 1=CompoundV3, 2=Morpho
    address user;            // dono da posição under-collateralized
    address debtAsset;
    address collateralAsset;
    uint256 debtAmount;
    uint256 maxFlashloanFee; // safety
    uint256 minProfitWei;
}

function liquidatePosition(LiquidationParams calldata params) external;
```

Internamente:
1. Flashloan `debtAsset` na quantia necessária
2. Callback chama `liquidationCall` no protocol
3. Recebe `collateralAsset` + bonus 5-10%
4. Swap collateral → debt asset (pra repagar flashloan)
5. Profit residual fica no executor → owner

---

## 🛡️ Audit Pipeline

### Pre-Foundry build (automatizado)
1. **Slither** (`slither contracts/`) — static analysis
2. **Mythril** (`myth analyze contracts/src/ZeusExecutor.sol`) — symbolic execution
3. **Forge fmt** — formatação consistente

### Foundry tests
4. **Unit tests** — coverage 95%+ em ZeusExecutor
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
myth analyze src/ZeusExecutor.sol

# Deploy testnet
forge script script/DeployExecutor.s.sol \
    --rpc-url base_sepolia \
    --broadcast \
    --verify \
    --etherscan-api-key $BASESCAN_API_KEY

# Deploy mainnet (após audit + multisig configurado)
forge script script/DeployExecutor.s.sol \
    --rpc-url base \
    --broadcast \
    --verify \
    --account safe_signer  # ledger ou multisig
```

### Governance pós-deploy

| Ação | Quem | Como |
|---|---|---|
| Pause/Kill switch | Owner (multisig 2-de-3) | `kill()` |
| Mudar max trade | Owner (multisig 2-de-3) | `setMaxTradeWei()` |
| Adicionar operator | Owner (multisig 2-de-3) | `setOperator()` |
| Aprovar novo adapter | Owner (multisig 2-de-3) | `approveDexAdapter()` |
| Rescue stuck tokens | Owner (multisig 2-de-3) | `rescueToken()` |
| Upgrade contract | **Não há** — deploy novo (intencional, sem proxy) |

**Decisão de design:** **NÃO usar proxy upgradeable.** Em caso de bug crítico:
1. Owner chama `kill()`
2. Owner chama `rescueToken()` pra recuperar fundos
3. Deploya novo executor
4. Atualiza detector pra usar novo address

Trade-off aceito: menos flexibilidade vs menos superfície de ataque (proxies têm CVEs documentadas).

---

## 🧠 Knowledge Limits da IA (Claude)

Transparência sobre meus limites pra cada componente:

| Área | Confiança | Mitigation |
|---|---|---|
| **ZeusExecutor com Ownable2Step + ReentrancyGuard + Pausable** | 🟢 Alto | Posso entregar direto, base OpenZeppelin |
| **Adapter Uniswap V3** | 🟢 Alto | Padrão bem documentado, posso entregar |
| **Adapter Aerodrome** | 🟡 Médio | Aerodrome tem nuances (ve(3,3), pools stable/volatile). Posso entregar mas recomendo conferir comportamento real em fork |
| **Callback Aave V3 Flashloan** | 🟢 Alto | Padrão IFlashLoanReceiver bem conhecido |
| **Liquidations Aave V3** | 🟢 Alto | `liquidationCall` é direto |
| **Liquidations Compound V3** | 🟡 Médio | Compound V3 tem API diferente do V2, menos exemplos |
| **Liquidations Morpho** | 🟡 Médio | Morpho tem variantes (Aave/Compound/Blue), API menos uniforme |
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
