# CONTEXT — ZEUS EVM

Regras, padrões e lógica de negócio. **Leia antes de qualquer alteração.**

---

## 🎯 Princípios não-negociáveis

### 1. Atomic-only
Toda operação de arb é **uma única transação**. Se qualquer step falha, tudo reverte. Sem estado intermediário travado, sem inventário órfão.

### 2. Self-custody com circuit breakers no contrato
O bot tem chave privada própria, mas o contrato `ZeusExecutor` valida:
- `MAX_TRADE_ETH` cap absoluto por tx
- `MIN_PROFIT_WEI` obrigatório — tx reverte se profit < threshold
- Kill switch global controlado por `owner` (multisig idealmente)

### 3. Fail-safe defaults
- `KILL_SWITCH` começa em `true` em deploy
- `ENABLE_LIQUIDATIONS` começa em `false`
- `MAX_SLIPPAGE_BPS` máximo de 100bps (1%)

### 4. Sem reuso de chave entre projetos
Chave privada do Zeus EVM é **exclusiva** dele. Nunca reaproveitar chave do Zeus Solana, MAZARI, etc. Compromisso = perda compartimentalizada.

### 5. Validar antes de escalar
Sequência obrigatória:
1. Foundry tests com fork mainnet (forge test)
2. Backtest contra histórico (scripts/simulate.ts)
3. Deploy Base Sepolia + simulação 2 semanas
4. Mainnet com capital pequeno (0.5 ETH) por 2-4 semanas
5. Só então aumentar capital

Pular etapa = perda de capital.

### 6. Mensurar antes de afirmar
Mesmo princípio do Chronos: **toda estratégia precisa de baseline mensurada**. "Achei que ia dar" não é argumento — só win rate out-of-sample ≥ X% justifica deploy.

---

## 🧠 Lógica de negócio

### Modalidade 1 — Wallet arb (capital próprio)
```
1. Bot tem saldo de ETH (e/ou USDC, WETH, etc) no Executor
2. Detector identifica oportunidade: token A em DEX X comprar / DEX Y vender
3. Detector codifica SwapStep[] e chama executor.executeArbitrage(params)
4. Contrato:
   a) Valida msg.sender == authorized
   b) Valida !killed
   c) Executa cada SwapStep em sequência
   d) Valida lucro >= minProfitWei (ELSE revert)
   e) Transfere lucro pra profitReceiver
   f) Emite ArbitrageExecuted event
```

### Modalidade 2 — Flashloan arb (capital ilimitado)
```
1. Detector identifica oportunidade que precisa size grande
2. Detector chama executor.executeFlashloanArbitrage(asset, amount, params)
3. Contrato chama Aave V3 Pool.flashLoanSimple(receiver=this, asset, amount, params)
4. Aave V3 transfere amount → executor + chama executor.executeOperation()
5. executor.executeOperation():
   a) Executa cada SwapStep com tokens emprestados
   b) Garante saldo final >= amount + premium (fee Aave 0.05%)
   c) Approve Aave pra puxar repay
   d) Valida lucro residual >= minProfitWei (ELSE revert)
   e) Transfere lucro pra profitReceiver
6. Aave V3 puxa repay automaticamente
7. Se qualquer revert: TUDO desfaz, bot só perde gas
```

### Estratégia 3 — Liquidations
```
1. Monitor (apps/monitor) observa health factors no Aave V3, Compound III, Morpho
2. Quando HF < 1.0 detectado pra position grande:
   a) Calcula bonus de liquidação (5-10% típico)
   b) Calcula custo: gas + flashloan fee (se usar)
3. Se profit líquido > MIN_PROFIT_USD:
   a) Chama executor.liquidatePosition(protocol, user, debtAsset, collateralAsset, amount)
4. Contrato:
   a) Borrow debt asset via flashloan
   b) Repay debt na protocol → recebe collateral + bonus
   c) Swap collateral → debt asset (pra repagar flashloan)
   d) Profit residual vai pro profitReceiver
```

---

## 📐 Convenções de código

### Solidity

- **Versão fixa:** `pragma solidity 0.8.27;` (não usar `^`)
- **Otimização:** `via_ir = true` + `optimizer_runs = 1_000_000` (hot path)
- **NatSpec:** docstrings `///` em funções públicas
- **Storage layout consciente** — usar `immutable` quando possível, agrupar slots
- **Custom errors** > require strings (gas)
- **Eventos** pra TODA operação state-changing (auditabilidade)

### Patterns mandatórios

- `ReentrancyGuard` em funções state-changing públicas
- `Ownable2Step` ao invés de `Ownable`
- `Pausable` com `whenNotPaused` em hot path
- Checks-effects-interactions sempre
- `SafeERC20` pra interagir com tokens (alguns tokens não retornam bool)

### TypeScript

- **Strict mode** ligado em `tsconfig.json`
- **viem** > ethers (mais moderno, type-safe nativo)
- **zod** pra validar config + input externo
- **pino** pra logs estruturados (JSON)
- **Async/await** > Promise chains
- Nenhum `any` exceto em fronteiras explícitas

### Nomenclatura

- **PascalCase:** contratos, structs, eventos, classes TS
- **camelCase:** funções, variáveis, hooks
- **SCREAMING_SNAKE:** constantes (incluindo `MAX_TRADE_ETH`)
- **kebab-case:** nomes de pacotes (`@zeus-evm/chain-config`)

### Estrutura de imports
```ts
// 1. Stdlib + libs externas
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';

// 2. Internos
import { CHAINS } from '@zeus-evm/chain-config';
import { logger } from './logger';
```

---

## 🎨 Estilo da estratégia

### Quais oportunidades vamos atacar (priorizadas)
1. **Cross-DEX em tokens medium-cap** com TVL US$ 1-50M
2. **Triangular intra-Uniswap V3** entre fee tiers (0.05% / 0.3% / 1%) em pares com volume
3. **Liquidations Aave V3** em momentos de alta volatilidade
4. **Dislocation pós-trade** detectada via mempool (Fase 2)

### Quais NÃO vamos atacar (decisão explícita)
- ❌ Arb cross-DEX em ETH/USDC (comoditizado, perdemos)
- ❌ Sandwich attacks (ético-questionável + Flashbots Protect ataca)
- ❌ Bridge arb (cross-chain) — território de hacks, alta complexidade
- ❌ MEV-Search via Flashbots bundle bidding na mainnet — competição com Wintermute é suicida
- ❌ Long-tail tokens com TVL < US$ 100k (slippage mata, risco de rug)

---

## 🛡️ Risk management on-chain (codificado no contrato)

| Cenário | Mitigação |
|---|---|
| Bot tenta gastar mais que MAX_TRADE_ETH | `require(amount <= MAX_TRADE_ETH)` no entrypoint |
| Profit menor que esperado | `require(profit >= minProfitWei)` ou revert |
| Slippage maior que tolerado | `minAmountOut` em cada SwapStep |
| Reentrancy em DEX comprometido | `ReentrancyGuard` em entry points |
| Erro lógico em código novo | `KILL_SWITCH` para tudo via owner call |
| Chave privada vazada | Owner (multisig) faz `pause()` + revoga approves |

---

## 🚫 Coisas proibidas

- ❌ **Commitar `.env`** ou qualquer chave privada
- ❌ **`npm install`** neste repo (preinstall bloqueia)
- ❌ **Deploy mainnet** sem audit interno + testnet 2 semanas mínimo
- ❌ **Mudar `MAX_TRADE_ETH` em runtime** sem timelock
- ❌ **Usar a mesma `EXECUTOR_PRIVATE_KEY` em dev e prod**
- ❌ **Skipar testes Foundry** com `--skip`
- ❌ **Implementar swap "manualmente"** — sempre via adapter já testado
- ❌ **Confiar em oracle externo** sem fallback (Chainlink + secondary)

---

## 🎙️ Voz e padrão de commits

- **PT-BR direto** nos commits e docs
- **Conventional Commits opcional**, mas mensagem clara obrigatória:
  - `feat(executor): adiciona suporte a Uniswap V3 fee tiers`
  - `fix(detector): corrige calculo de slippage minimo`
  - `refactor(adapters): extrai BaseSwap pra adapter dedicado`
  - `chore(deps): bump viem 2.21 -> 2.22`

---

## 🤖 Regras pra IA assistente (Claude)

- **Sempre** `pnpm typecheck && pnpm contracts:test` antes de declarar "concluído"
- **Sempre** atualizar TODO.md ao concluir/iniciar fase
- **Nunca** modificar `.env` (só `.env.example`)
- **Nunca** assumir que mainnet "vai funcionar" sem testar em fork primeiro
- **Quando em dúvida** sobre matemática (slippage, fee calc), perguntar ao Humberto
- **Sempre** usar adapter quando existir; só criar novo se realmente faltar
- **Ao adicionar dep**, usar `catalog:` do pnpm-workspace.yaml se existir
- **Reconhecer limites:** audit profissional é mandatório antes de capital alto
