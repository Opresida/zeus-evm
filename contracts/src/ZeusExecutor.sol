// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IZeusExecutor, SwapStep, ArbitrageParams, LiquidationParams, CompoundLiquidationParams, MorphoLiquidationParams, BackrunParams, BribeConfig, DexType, OperationType} from "./interfaces/IZeusExecutor.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/aave/IFlashLoanSimpleReceiver.sol";
import {IPool} from "./interfaces/aave/IPool.sol";
import {IComet} from "./interfaces/compound/IComet.sol";
import {IMorpho, MarketParams} from "./interfaces/morpho/IMorpho.sol";
import {UniswapV3Lib} from "./libraries/UniswapV3Lib.sol";
import {AerodromeLib} from "./libraries/AerodromeLib.sol";

/// @notice Interface mínima WETH9 — usada pra unwrap antes do coinbase.transfer.
interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Interface UniV3 SwapRouter02 inline (igual UniswapV3Lib mas reusada aqui pro swap pra bribe).
interface IUniV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title ZeusExecutor — Atomic arbitrage executor on EVM
/// @notice Entry point único pra arbitragens atômicas:
///         1. Modalidade capital próprio: bot transfere tokens → executor faz multi-swap → devolve lucro
///         2. Modalidade flashloan: borrow Aave V3 → multi-swap → repay tudo em 1 tx
/// @dev Princípios de segurança:
///      - Atomic-only: qualquer falha reverte tudo
///      - Self-custody com circuit breakers (kill switch + maxTradeWei + minProfit obrigatório)
///      - Owner = multisig em produção (Safe Wallet)
///      - Sem proxy upgradeable (bug → deploy novo)
contract ZeusExecutor is IZeusExecutor, IFlashLoanSimpleReceiver, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Aave V3 Pool — imutável após deploy
    address public immutable AAVE_V3_POOL;

    /// @notice Limite máximo de amountIn (fallback global em wei) — usado quando token-specific
    /// override não estiver configurado. Mantido pra compat com semântica antiga.
    /// @dev ⚠️ Este valor é "wei" no sentido genérico (smallest unit). Pra tokens não-18-decimais
    /// (USDC/USDT/WBTC), configure override via `setMaxTradePerToken` — fallback aplicado a
    /// tokens não cadastrados pode estar muito alto ou muito baixo (H-02).
    uint256 public maxTradeWei;

    /// @notice Cap específico por token (em wei do token). Se 0, usa fallback `maxTradeWei`.
    /// Resolve H-02: cap por token elimina mistura entre 6/8/18 decimais.
    mapping(address => uint256) private _maxTradePerToken;

    /// @notice Wallets autorizadas a chamar entry points (além do owner)
    mapping(address => bool) private _operators;

    /// @notice Override do Pausable pra UX clara via boolean dedicado
    bool private _killed;

    /// @notice Endereço WETH da chain. Setado via setWeth() pelo owner.
    /// @dev Usado pra: (a) unwrap antes de coinbase.transfer; (b) destino do swap inline
    ///      quando profitToken != WETH. Quando address(0), bribe via swap fica indisponível
    ///      (apenas profitToken == WETH ainda funciona, mas o caso comum precisa do WETH addr).
    address public weth;

    /// @notice Endereço UniV3 SwapRouter02 da chain. Setado via setUniV3SwapRouter() pelo owner.
    /// @dev Usado pra swap inline `profitToken → WETH` quando profitToken != WETH no fluxo de bribe.
    address public uniV3SwapRouter;

    /// @notice Cap do bribe em bps (10000 = 100%). Hardcoded ceiling — owner não pode
    /// configurar bribe acima de 9900 (99%). Garante que sempre sobra ao menos 1% pro receiver.
    uint256 internal constant ABSOLUTE_BRIBE_CAP_BPS = 9_900;

    // ════════ CONSTRUCTOR ════════

    constructor(address aaveV3Pool, address initialOwner, uint256 initialMaxTradeWei) Ownable(initialOwner) {
        if (aaveV3Pool == address(0) || initialOwner == address(0)) revert NotAuthorized();
        AAVE_V3_POOL = aaveV3Pool;
        maxTradeWei = initialMaxTradeWei;
        _killed = true; // fail-safe: começa morto, owner ativa explicitamente
        emit Killed();
    }

    // ════════ MODIFIERS ════════

    modifier onlyOperator() {
        if (msg.sender != owner() && !_operators[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier whenAlive() {
        if (_killed) revert BotKilled();
        _;
    }

    // ════════ ARBITRAGE ENTRYPOINTS ════════

    /// @inheritdoc IZeusExecutor
    function executeArbitrage(ArbitrageParams calldata params)
        external
        override
        onlyOperator
        whenNotPaused
        whenAlive
        nonReentrant
    {
        if (params.steps.length == 0) revert EmptySteps();

        // Saldo inicial do profit token (pode ser diferente de zero — operador deixou capital aqui)
        uint256 balanceBefore = IERC20(params.profitToken).balanceOf(address(this));

        _executeSwaps(params.steps);

        // Lucro = saldo final - saldo inicial
        uint256 balanceAfter = IERC20(params.profitToken).balanceOf(address(this));
        if (balanceAfter < balanceBefore + params.minProfitWei) {
            revert InsufficientProfit(
                balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0,
                params.minProfitWei
            );
        }

        uint256 profit = balanceAfter - balanceBefore;

        // Transfere apenas o lucro residual (mantém o capital inicial)
        if (params.profitReceiver != address(this) && profit > 0) {
            IERC20(params.profitToken).safeTransfer(params.profitReceiver, profit);
        }

        emit ArbitrageExecuted(msg.sender, params.profitToken, profit, params.steps.length);
    }

    /// @inheritdoc IZeusExecutor
    function executeFlashloanArbitrage(
        address flashloanAsset,
        uint256 flashloanAmount,
        ArbitrageParams calldata params
    ) external override onlyOperator whenNotPaused whenAlive nonReentrant {
        if (params.steps.length == 0) revert EmptySteps();
        uint256 cap = getMaxTradeFor(flashloanAsset);
        if (flashloanAmount > cap) revert TradeTooLarge(flashloanAmount, cap);

        // Encoda discriminator + arb params + operator pra passar pro callback executeOperation
        bytes memory encodedParams = abi.encode(OperationType.Arbitrage, abi.encode(params, msg.sender));

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            flashloanAsset,
            flashloanAmount,
            encodedParams,
            0 // sem referral
        );
        // Aave chama executeOperation aqui (callback). Se reverter, toda a tx reverte.
    }

    /// @inheritdoc IZeusExecutor
    function executeLiquidation(LiquidationParams calldata params)
        external
        override
        onlyOperator
        whenNotPaused
        whenAlive
        nonReentrant
    {
        uint256 cap = getMaxTradeFor(params.debtAsset);
        if (params.debtToCover > cap) revert TradeTooLarge(params.debtToCover, cap);

        // Snapshot pre-flashloan do debtAsset (M-01 fix): impede que saldo pre-existente
        // do contrato vaze pro profit pago ao profitReceiver.
        uint256 debtBalanceBefore = IERC20(params.debtAsset).balanceOf(address(this));

        // Encoda discriminator + liquidation params + operator + balanceBefore
        bytes memory encodedParams = abi.encode(
            OperationType.Liquidation,
            abi.encode(params, msg.sender, debtBalanceBefore)
        );

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            params.debtAsset,
            params.debtToCover,
            encodedParams,
            0
        );
        // Aave chama executeOperation aqui — _handleLiquidation roda lá dentro
    }

    /// @inheritdoc IZeusExecutor
    function executeCompoundLiquidation(CompoundLiquidationParams calldata params)
        external
        override
        onlyOperator
        whenNotPaused
        whenAlive
        nonReentrant
    {
        if (params.comet == address(0) || params.borrower == address(0)) revert NotAuthorized();

        // baseToken do Comet = asset que vamos pegar emprestado no Aave (mesmo asset)
        address baseAsset = IComet(params.comet).baseToken();

        uint256 cap = getMaxTradeFor(baseAsset);
        if (params.baseAmount > cap) revert TradeTooLarge(params.baseAmount, cap);

        // Snapshot pre-flashloan do baseAsset (M-01 fix)
        uint256 baseBalanceBefore = IERC20(baseAsset).balanceOf(address(this));

        bytes memory encodedParams = abi.encode(
            OperationType.CompoundLiquidation,
            abi.encode(params, msg.sender, baseBalanceBefore)
        );

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            baseAsset,
            params.baseAmount,
            encodedParams,
            0
        );
        // Callback executa _handleCompoundLiquidationOperation
    }

    /// @inheritdoc IZeusExecutor
    function executeMorphoLiquidation(MorphoLiquidationParams calldata params)
        external
        override
        onlyOperator
        whenNotPaused
        whenAlive
        nonReentrant
    {
        if (params.morpho == address(0) || params.borrower == address(0)) revert NotAuthorized();
        if (params.loanToken == address(0) || params.collateralToken == address(0)) revert NotAuthorized();
        // M-02 fix: flashloanAmount é EXPLÍCITO em wei do loanToken (computado off-chain via
        // simulação eth_call). Não confunde mais com seizedAssets (collateralToken wei).
        if (params.flashloanAmount == 0) revert EmptySteps();

        uint256 cap = getMaxTradeFor(params.loanToken);
        if (params.flashloanAmount > cap) revert TradeTooLarge(params.flashloanAmount, cap);

        // Snapshot pre-flashloan do loanToken (M-01 fix)
        uint256 loanBalanceBefore = IERC20(params.loanToken).balanceOf(address(this));

        bytes memory encodedParams = abi.encode(
            OperationType.MorphoLiquidation,
            abi.encode(params, msg.sender, loanBalanceBefore)
        );

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            params.loanToken,
            params.flashloanAmount,
            encodedParams,
            0
        );
        // Callback executa _handleMorphoLiquidationOperation
    }

    /// @inheritdoc IFlashLoanSimpleReceiver
    /// @notice Callback chamado pelo Aave V3 Pool após emprestar tokens
    /// @dev Validações:
    ///      - Só Aave V3 Pool pode chamar
    ///      - Initiator deve ser este contrato (defesa contra terceiros usando nosso receiver)
    ///      - Dispatch por OperationType (Arbitrage vs Liquidation)
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != AAVE_V3_POOL) revert InvalidCaller();
        if (initiator != address(this)) revert InvalidCaller();

        (OperationType opType, bytes memory inner) = abi.decode(params, (OperationType, bytes));

        if (opType == OperationType.Arbitrage) {
            _handleArbitrageOperation(asset, amount, premium, inner);
        } else if (opType == OperationType.Liquidation) {
            _handleLiquidationOperation(asset, amount, premium, inner);
        } else if (opType == OperationType.CompoundLiquidation) {
            _handleCompoundLiquidationOperation(asset, amount, premium, inner);
        } else if (opType == OperationType.MorphoLiquidation) {
            _handleMorphoLiquidationOperation(asset, amount, premium, inner);
        } else if (opType == OperationType.FlashloanBackrun) {
            _handleFlashloanBackrun(asset, amount, premium, inner);
        } else if (opType == OperationType.LiquidationWithBribe) {
            _handleLiquidationWithBribeOperation(asset, amount, premium, inner);
        } else if (opType == OperationType.CompoundLiquidationWithBribe) {
            _handleCompoundLiquidationWithBribeOperation(asset, amount, premium, inner);
        } else if (opType == OperationType.MorphoLiquidationWithBribe) {
            _handleMorphoLiquidationWithBribeOperation(asset, amount, premium, inner);
        } else {
            revert InvalidCaller(); // OperationType desconhecido
        }

        // Approve Aave pra puxar repay (válido pra ambos os fluxos)
        IERC20(asset).forceApprove(AAVE_V3_POOL, amount + premium);

        return true;
    }

    function _handleArbitrageOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        (ArbitrageParams memory arbParams, address operator) = abi.decode(inner, (ArbitrageParams, address));

        // Estado pré-arb pra calcular lucro
        uint256 balanceBefore = IERC20(arbParams.profitToken).balanceOf(address(this));

        // Importante: subtraímos o flashloan amount se profitToken == asset emprestado
        if (arbParams.profitToken == asset) {
            balanceBefore = balanceBefore > amount ? balanceBefore - amount : 0;
        }

        _executeSwaps(arbParams.steps);

        uint256 balanceAfter = IERC20(arbParams.profitToken).balanceOf(address(this));
        uint256 amountOwed = amount + premium;
        uint256 assetBalance = IERC20(asset).balanceOf(address(this));
        if (assetBalance < amountOwed) revert FlashloanRepayShortfall(assetBalance, amountOwed);

        uint256 profit;
        if (arbParams.profitToken == asset) {
            uint256 effectiveBalance = balanceAfter >= amountOwed ? balanceAfter - amountOwed : 0;
            if (effectiveBalance < balanceBefore + arbParams.minProfitWei) {
                revert InsufficientProfit(
                    effectiveBalance > balanceBefore ? effectiveBalance - balanceBefore : 0,
                    arbParams.minProfitWei
                );
            }
            profit = effectiveBalance - balanceBefore;
        } else {
            if (balanceAfter < balanceBefore + arbParams.minProfitWei) {
                revert InsufficientProfit(
                    balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0,
                    arbParams.minProfitWei
                );
            }
            profit = balanceAfter - balanceBefore;
        }

        if (arbParams.profitReceiver != address(this) && profit > 0) {
            IERC20(arbParams.profitToken).safeTransfer(arbParams.profitReceiver, profit);
        }

        emit FlashloanArbitrageExecuted(operator, asset, amount, premium, arbParams.profitToken, profit);
    }

    function _handleLiquidationOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        // M-01 fix: decode inclui `debtBalanceBefore` (snapshot pre-flashloan) pra
        // evitar que saldo pre-existente vaze pro profit.
        (LiquidationParams memory liqParams, address operator, uint256 debtBalanceBefore) =
            abi.decode(inner, (LiquidationParams, address, uint256));

        // asset emprestado deve bater com debtAsset (sanity check)
        if (asset != liqParams.debtAsset) revert InvalidCaller();

        uint256 collateralBefore = IERC20(liqParams.collateralAsset).balanceOf(address(this));

        // 1. Aprovar Aave pra puxar o debtAsset que vai ser quitado
        IERC20(liqParams.debtAsset).forceApprove(AAVE_V3_POOL, liqParams.debtToCover);

        // 2. Chamar liquidationCall — Aave puxa debtAsset e devolve collateralAsset + bonus
        IPool(AAVE_V3_POOL).liquidationCall(
            liqParams.collateralAsset,
            liqParams.debtAsset,
            liqParams.user,
            liqParams.debtToCover,
            false // receiveAToken=false: recebemos colateral cru, não aToken
        );

        uint256 collateralReceived = IERC20(liqParams.collateralAsset).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1); // liquidação falhou silenciosamente

        // 3. Swap collateral → debtAsset (usando swapSteps fornecidos)
        if (liqParams.swapSteps.length > 0) {
            _executeSwaps(liqParams.swapSteps);
        }

        // 4. Validar capacidade de repay considerando saldo pre-existente
        // (M-01): exige amountOwed em NOVOS fundos (swap output) — pre-existing fica protegido.
        uint256 amountOwed = amount + premium;
        uint256 debtAssetBalance = IERC20(liqParams.debtAsset).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + debtBalanceBefore;
        if (debtAssetBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(debtAssetBalance, minRequiredBalance);
        }

        // 5. Profit líquido = (saldo final) − (repay flashloan) − (saldo pre-existente)
        uint256 profit = debtAssetBalance - amountOwed - debtBalanceBefore;
        if (profit < liqParams.minProfitWei) {
            revert InsufficientProfit(profit, liqParams.minProfitWei);
        }

        // 6. Transferir profit pro receiver
        if (liqParams.profitReceiver != address(this) && profit > 0) {
            IERC20(liqParams.debtAsset).safeTransfer(liqParams.profitReceiver, profit);
        }

        emit LiquidationExecuted(
            operator,
            liqParams.user,
            liqParams.collateralAsset,
            liqParams.debtAsset,
            liqParams.debtToCover,
            collateralReceived,
            profit
        );
    }

    /// @dev Liquidação Compound III (Comet) — 2-step: absorb + buyCollateral
    function _handleCompoundLiquidationOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        // M-01 fix: decode inclui `baseBalanceBefore`
        (CompoundLiquidationParams memory cp, address operator, uint256 baseBalanceBefore) =
            abi.decode(inner, (CompoundLiquidationParams, address, uint256));

        // asset emprestado deve bater com baseToken do Comet
        if (asset != IComet(cp.comet).baseToken()) revert InvalidCaller();

        uint256 collateralBefore = IERC20(cp.collateralAsset).balanceOf(address(this));

        // 1. Absorb position underwater — protocolo absorve a dívida do borrower
        address[] memory accounts = new address[](1);
        accounts[0] = cp.borrower;
        IComet(cp.comet).absorb(address(this), accounts);

        // 2. Aprovar Comet pra puxar base token na compra de collateral
        IERC20(asset).forceApprove(cp.comet, cp.baseAmount);

        // 3. Comprar collateral com desconto
        IComet(cp.comet).buyCollateral(
            cp.collateralAsset,
            cp.minCollateralReceived,
            cp.baseAmount,
            address(this)
        );

        uint256 collateralReceived = IERC20(cp.collateralAsset).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        // 4. Swap collateral → base token via DEX (UniV3/Aerodrome)
        if (cp.swapSteps.length > 0) {
            _executeSwaps(cp.swapSteps);
        }

        // 5. Validar capacidade de repay considerando saldo pre-existente (M-01)
        uint256 amountOwed = amount + premium;
        uint256 baseBalance = IERC20(asset).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + baseBalanceBefore;
        if (baseBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(baseBalance, minRequiredBalance);
        }

        // 6. Profit líquido = saldo final − repay − pre-existente
        uint256 profit = baseBalance - amountOwed - baseBalanceBefore;
        if (profit < cp.minProfitWei) revert InsufficientProfit(profit, cp.minProfitWei);

        // 7. Transferir profit pro receiver
        if (cp.profitReceiver != address(this) && profit > 0) {
            IERC20(asset).safeTransfer(cp.profitReceiver, profit);
        }

        emit CompoundLiquidationExecuted(
            operator,
            cp.comet,
            cp.borrower,
            cp.collateralAsset,
            cp.baseAmount,
            collateralReceived,
            profit
        );
    }

    /// @dev Liquidação Morpho Blue — markets isolados, 1 call atômica
    function _handleMorphoLiquidationOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        // M-01 fix: decode inclui `loanBalanceBefore`
        (MorphoLiquidationParams memory mp, address operator, uint256 loanBalanceBefore) =
            abi.decode(inner, (MorphoLiquidationParams, address, uint256));

        // asset emprestado deve bater com loanToken (sanity check)
        if (asset != mp.loanToken) revert InvalidCaller();

        uint256 collateralBefore = IERC20(mp.collateralToken).balanceOf(address(this));

        // 1. H-01 fix: approval BOUNDED ao valor exato do flashloan (não mais infinito).
        // Morpho pulla até `assetsRepaid` (computado por Morpho) — limitado pelo flashloan amount.
        IERC20(mp.loanToken).forceApprove(mp.morpho, amount);

        // 2. Chamar Morpho.liquidate
        MarketParams memory marketParams = MarketParams({
            loanToken: mp.loanToken,
            collateralToken: mp.collateralToken,
            oracle: mp.oracle,
            irm: mp.irm,
            lltv: mp.lltv
        });

        IMorpho(mp.morpho).liquidate(
            marketParams,
            mp.borrower,
            mp.seizedAssets,
            mp.repaidShares,
            "" // sem callback custom
        );

        // H-01 fix: RESET approval pra 0 pra eliminar persistência post-tx caso `mp.morpho`
        // seja malicioso. Sem isso, malicious morpho contract com `liquidate()` que não consome
        // toda a approval poderia fazer transferFrom posteriormente.
        IERC20(mp.loanToken).forceApprove(mp.morpho, 0);

        uint256 collateralReceived = IERC20(mp.collateralToken).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        // 3. Swap collateral → loanToken via DEX
        if (mp.swapSteps.length > 0) {
            _executeSwaps(mp.swapSteps);
        }

        // 4. Validar capacidade de repay considerando saldo pre-existente (M-01)
        uint256 amountOwed = amount + premium;
        uint256 loanBalance = IERC20(mp.loanToken).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + loanBalanceBefore;
        if (loanBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(loanBalance, minRequiredBalance);
        }

        // 5. Profit líquido = saldo final − repay − pre-existente
        uint256 profit = loanBalance - amountOwed - loanBalanceBefore;
        if (profit < mp.minProfitWei) revert InsufficientProfit(profit, mp.minProfitWei);

        // 6. Transferir profit pro receiver
        if (mp.profitReceiver != address(this) && profit > 0) {
            IERC20(mp.loanToken).safeTransfer(mp.profitReceiver, profit);
        }

        emit MorphoLiquidationExecuted(
            operator,
            mp.borrower,
            mp.collateralToken,
            mp.loanToken,
            amount, // assets do flashloan que cobriu a liquidação
            collateralReceived,
            profit
        );
    }

    // ════════ BACKRUN + LIQUIDATIONS COM BRIBE (V7) ════════

    /// @inheritdoc IZeusExecutor
    function executeFlashloanBackrun(
        address flashloanAsset,
        uint256 flashloanAmount,
        BackrunParams calldata params
    ) external override onlyOperator whenNotPaused whenAlive nonReentrant {
        if (params.steps.length == 0) revert EmptySteps();
        // Audit Pass 3 fix L-01 + L-02: rejeitar address(0) cedo (não esperar safeTransfer
        // ou IERC20(0).balanceOf falhar com mensagem ruim).
        if (params.profitReceiver == address(0)) revert NotAuthorized();
        if (params.profitToken == address(0)) revert NotAuthorized();
        if (flashloanAsset == address(0)) revert NotAuthorized();
        _validateBribeConfig(params.bribe);

        uint256 cap = getMaxTradeFor(flashloanAsset);
        if (flashloanAmount > cap) revert TradeTooLarge(flashloanAmount, cap);

        bytes memory encodedParams = abi.encode(
            OperationType.FlashloanBackrun,
            abi.encode(params, msg.sender)
        );

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            flashloanAsset,
            flashloanAmount,
            encodedParams,
            0
        );
    }

    /// @inheritdoc IZeusExecutor
    function executeLiquidationWithBribe(
        LiquidationParams calldata params,
        BribeConfig calldata bribe
    ) external override onlyOperator whenNotPaused whenAlive nonReentrant {
        // Audit Pass 3 fix L-01: rejeitar address(0) cedo
        if (params.profitReceiver == address(0)) revert NotAuthorized();
        if (params.debtAsset == address(0)) revert NotAuthorized();
        if (params.collateralAsset == address(0)) revert NotAuthorized();
        if (params.user == address(0)) revert NotAuthorized();
        _validateBribeConfig(bribe);

        uint256 cap = getMaxTradeFor(params.debtAsset);
        if (params.debtToCover > cap) revert TradeTooLarge(params.debtToCover, cap);

        uint256 debtBalanceBefore = IERC20(params.debtAsset).balanceOf(address(this));

        bytes memory encodedParams = abi.encode(
            OperationType.LiquidationWithBribe,
            abi.encode(params, bribe, msg.sender, debtBalanceBefore)
        );

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            params.debtAsset,
            params.debtToCover,
            encodedParams,
            0
        );
    }

    /// @inheritdoc IZeusExecutor
    function executeCompoundLiquidationWithBribe(
        CompoundLiquidationParams calldata params,
        BribeConfig calldata bribe
    ) external override onlyOperator whenNotPaused whenAlive nonReentrant {
        if (params.comet == address(0) || params.borrower == address(0)) revert NotAuthorized();
        // Audit Pass 3 fix L-01: rejeitar address(0) cedo
        if (params.profitReceiver == address(0)) revert NotAuthorized();
        if (params.collateralAsset == address(0)) revert NotAuthorized();
        _validateBribeConfig(bribe);

        address baseAsset = IComet(params.comet).baseToken();
        uint256 cap = getMaxTradeFor(baseAsset);
        if (params.baseAmount > cap) revert TradeTooLarge(params.baseAmount, cap);

        uint256 baseBalanceBefore = IERC20(baseAsset).balanceOf(address(this));

        bytes memory encodedParams = abi.encode(
            OperationType.CompoundLiquidationWithBribe,
            abi.encode(params, bribe, msg.sender, baseBalanceBefore)
        );

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            baseAsset,
            params.baseAmount,
            encodedParams,
            0
        );
    }

    /// @inheritdoc IZeusExecutor
    function executeMorphoLiquidationWithBribe(
        MorphoLiquidationParams calldata params,
        BribeConfig calldata bribe
    ) external override onlyOperator whenNotPaused whenAlive nonReentrant {
        if (params.morpho == address(0) || params.borrower == address(0)) revert NotAuthorized();
        if (params.loanToken == address(0) || params.collateralToken == address(0)) revert NotAuthorized();
        // Audit Pass 3 fix L-01: rejeitar profitReceiver(0) cedo
        if (params.profitReceiver == address(0)) revert NotAuthorized();
        if (params.flashloanAmount == 0) revert EmptySteps();
        _validateBribeConfig(bribe);

        uint256 cap = getMaxTradeFor(params.loanToken);
        if (params.flashloanAmount > cap) revert TradeTooLarge(params.flashloanAmount, cap);

        uint256 loanBalanceBefore = IERC20(params.loanToken).balanceOf(address(this));

        bytes memory encodedParams = abi.encode(
            OperationType.MorphoLiquidationWithBribe,
            abi.encode(params, bribe, msg.sender, loanBalanceBefore)
        );

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            params.loanToken,
            params.flashloanAmount,
            encodedParams,
            0
        );
    }

    // ════════ INTERNAL HANDLERS (V7) ════════

    function _handleFlashloanBackrun(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        (BackrunParams memory bp, address operator) = abi.decode(inner, (BackrunParams, address));

        // Snapshot pre-arb do profitToken. Se profitToken == flashloanAsset, descontamos
        // o flashloan amount pra evitar contar como saldo prévio.
        uint256 balanceBefore = IERC20(bp.profitToken).balanceOf(address(this));
        if (bp.profitToken == asset) {
            balanceBefore = balanceBefore > amount ? balanceBefore - amount : 0;
        }

        _executeSwaps(bp.steps);

        uint256 balanceAfter = IERC20(bp.profitToken).balanceOf(address(this));
        uint256 amountOwed = amount + premium;
        uint256 assetBalance = IERC20(asset).balanceOf(address(this));
        if (assetBalance < amountOwed) revert FlashloanRepayShortfall(assetBalance, amountOwed);

        // Profit gross (ANTES do bribe). Mesma lógica do _handleArbitrageOperation —
        // se profitToken == asset, considera o flashloan owed.
        uint256 grossProfit;
        if (bp.profitToken == asset) {
            uint256 effectiveBalance = balanceAfter >= amountOwed ? balanceAfter - amountOwed : 0;
            if (effectiveBalance < balanceBefore + bp.minProfitWei) {
                revert InsufficientProfit(
                    effectiveBalance > balanceBefore ? effectiveBalance - balanceBefore : 0,
                    bp.minProfitWei
                );
            }
            grossProfit = effectiveBalance - balanceBefore;
        } else {
            if (balanceAfter < balanceBefore + bp.minProfitWei) {
                revert InsufficientProfit(
                    balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0,
                    bp.minProfitWei
                );
            }
            grossProfit = balanceAfter - balanceBefore;
        }

        // Bribe (swap inline + unwrap + coinbase.transfer)
        (uint256 bribeNativeWei, uint256 profitConsumed) =
            _payBribe(bp.profitToken, grossProfit, bp.bribe, OperationType.FlashloanBackrun, operator);

        // Net profit em profitToken (após subtrair o que foi consumido pelo swap pra bribe)
        uint256 netProfit = grossProfit - profitConsumed;

        // minProfitWei é checado contra NET (não gross) — garantia honesta de profit
        if (netProfit < bp.minProfitWei) revert InsufficientProfit(netProfit, bp.minProfitWei);

        // Transfere net profit pro receiver (somente o residual em profitToken)
        if (bp.profitReceiver != address(this) && netProfit > 0) {
            IERC20(bp.profitToken).safeTransfer(bp.profitReceiver, netProfit);
        }

        emit BackrunExecuted(operator, asset, bp.profitToken, amount, grossProfit, bribeNativeWei, netProfit);
    }

    function _handleLiquidationWithBribeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        (LiquidationParams memory liqParams, BribeConfig memory bribe, address operator, uint256 debtBalanceBefore) =
            abi.decode(inner, (LiquidationParams, BribeConfig, address, uint256));

        if (asset != liqParams.debtAsset) revert InvalidCaller();

        uint256 collateralBefore = IERC20(liqParams.collateralAsset).balanceOf(address(this));

        IERC20(liqParams.debtAsset).forceApprove(AAVE_V3_POOL, liqParams.debtToCover);

        IPool(AAVE_V3_POOL).liquidationCall(
            liqParams.collateralAsset,
            liqParams.debtAsset,
            liqParams.user,
            liqParams.debtToCover,
            false
        );

        uint256 collateralReceived = IERC20(liqParams.collateralAsset).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        if (liqParams.swapSteps.length > 0) {
            _executeSwaps(liqParams.swapSteps);
        }

        uint256 amountOwed = amount + premium;
        uint256 debtAssetBalance = IERC20(liqParams.debtAsset).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + debtBalanceBefore;
        if (debtAssetBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(debtAssetBalance, minRequiredBalance);
        }

        uint256 grossProfit = debtAssetBalance - amountOwed - debtBalanceBefore;
        if (grossProfit < liqParams.minProfitWei) {
            revert InsufficientProfit(grossProfit, liqParams.minProfitWei);
        }

        // bribeNativeWei é emitido em BribePaid pelo _payBribe — não precisa repassar aqui.
        (, uint256 profitConsumed) =
            _payBribe(liqParams.debtAsset, grossProfit, bribe, OperationType.LiquidationWithBribe, operator);

        uint256 netProfit = grossProfit - profitConsumed;
        if (netProfit < liqParams.minProfitWei) revert InsufficientProfit(netProfit, liqParams.minProfitWei);

        if (liqParams.profitReceiver != address(this) && netProfit > 0) {
            IERC20(liqParams.debtAsset).safeTransfer(liqParams.profitReceiver, netProfit);
        }

        emit LiquidationExecuted(
            operator,
            liqParams.user,
            liqParams.collateralAsset,
            liqParams.debtAsset,
            liqParams.debtToCover,
            collateralReceived,
            netProfit
        );
    }

    function _handleCompoundLiquidationWithBribeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        (CompoundLiquidationParams memory cp, BribeConfig memory bribe, address operator, uint256 baseBalanceBefore) =
            abi.decode(inner, (CompoundLiquidationParams, BribeConfig, address, uint256));

        if (asset != IComet(cp.comet).baseToken()) revert InvalidCaller();

        uint256 collateralBefore = IERC20(cp.collateralAsset).balanceOf(address(this));

        address[] memory accounts = new address[](1);
        accounts[0] = cp.borrower;
        IComet(cp.comet).absorb(address(this), accounts);

        IERC20(asset).forceApprove(cp.comet, cp.baseAmount);
        IComet(cp.comet).buyCollateral(cp.collateralAsset, cp.minCollateralReceived, cp.baseAmount, address(this));

        uint256 collateralReceived = IERC20(cp.collateralAsset).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        if (cp.swapSteps.length > 0) {
            _executeSwaps(cp.swapSteps);
        }

        uint256 amountOwed = amount + premium;
        uint256 baseBalance = IERC20(asset).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + baseBalanceBefore;
        if (baseBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(baseBalance, minRequiredBalance);
        }

        uint256 grossProfit = baseBalance - amountOwed - baseBalanceBefore;
        if (grossProfit < cp.minProfitWei) revert InsufficientProfit(grossProfit, cp.minProfitWei);

        (, uint256 profitConsumed) =
            _payBribe(asset, grossProfit, bribe, OperationType.CompoundLiquidationWithBribe, operator);

        uint256 netProfit = grossProfit - profitConsumed;
        if (netProfit < cp.minProfitWei) revert InsufficientProfit(netProfit, cp.minProfitWei);

        if (cp.profitReceiver != address(this) && netProfit > 0) {
            IERC20(asset).safeTransfer(cp.profitReceiver, netProfit);
        }

        emit CompoundLiquidationExecuted(
            operator, cp.comet, cp.borrower, cp.collateralAsset, cp.baseAmount, collateralReceived, netProfit
        );
    }

    function _handleMorphoLiquidationWithBribeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        (MorphoLiquidationParams memory mp, BribeConfig memory bribe, address operator, uint256 loanBalanceBefore) =
            abi.decode(inner, (MorphoLiquidationParams, BribeConfig, address, uint256));

        if (asset != mp.loanToken) revert InvalidCaller();

        uint256 collateralBefore = IERC20(mp.collateralToken).balanceOf(address(this));

        IERC20(mp.loanToken).forceApprove(mp.morpho, amount);

        MarketParams memory marketParams = MarketParams({
            loanToken: mp.loanToken,
            collateralToken: mp.collateralToken,
            oracle: mp.oracle,
            irm: mp.irm,
            lltv: mp.lltv
        });

        IMorpho(mp.morpho).liquidate(marketParams, mp.borrower, mp.seizedAssets, mp.repaidShares, "");

        IERC20(mp.loanToken).forceApprove(mp.morpho, 0);

        uint256 collateralReceived = IERC20(mp.collateralToken).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        if (mp.swapSteps.length > 0) {
            _executeSwaps(mp.swapSteps);
        }

        uint256 amountOwed = amount + premium;
        uint256 loanBalance = IERC20(mp.loanToken).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + loanBalanceBefore;
        if (loanBalance < minRequiredBalance) {
            revert FlashloanRepayShortfall(loanBalance, minRequiredBalance);
        }

        uint256 grossProfit = loanBalance - amountOwed - loanBalanceBefore;
        if (grossProfit < mp.minProfitWei) revert InsufficientProfit(grossProfit, mp.minProfitWei);

        (, uint256 profitConsumed) =
            _payBribe(mp.loanToken, grossProfit, bribe, OperationType.MorphoLiquidationWithBribe, operator);

        uint256 netProfit = grossProfit - profitConsumed;
        if (netProfit < mp.minProfitWei) revert InsufficientProfit(netProfit, mp.minProfitWei);

        if (mp.profitReceiver != address(this) && netProfit > 0) {
            IERC20(mp.loanToken).safeTransfer(mp.profitReceiver, netProfit);
        }

        emit MorphoLiquidationExecuted(
            operator, mp.borrower, mp.collateralToken, mp.loanToken, amount, collateralReceived, netProfit
        );
    }

    // ════════ BRIBE INTERNAL HELPERS ════════

    /// @notice Valida BribeConfig on-chain. Aceita bribeBps == 0 (sem bribe) como valor neutro.
    /// @dev Audit Pass 3 fix M-03: rejeita combinação `bribeBps == 0 && minBribeWei > 0`.
    ///      Esse caso forçaria swap com amountIn=0 (sem efeito) e reverteria tarde no
    ///      router — feedback ruim pro caller. Melhor reverter cedo com InvalidBribeConfig.
    function _validateBribeConfig(BribeConfig memory bribe) internal pure {
        if (bribe.bribeBps == 0 && bribe.minBribeWei == 0) {
            // Sem bribe — config neutra, OK.
            return;
        }
        // M-03 (v7) fix: minBribeWei > 0 sem bribeBps > 0 é incoerente. minBribeWei é piso
        // sobre o resultado percentual; sem percentual base, não há nada pra pisar.
        if (bribe.bribeBps == 0) revert InvalidBribeConfig();
        if (bribe.bribeBps > 10_000) revert InvalidBribeConfig();
        if (bribe.bribeMaxBps == 0 || bribe.bribeMaxBps > ABSOLUTE_BRIBE_CAP_BPS) revert InvalidBribeConfig();
        if (bribe.swapSlippageBps > 1_000) revert InvalidBribeConfig();
    }

    /// @notice Paga bribe ao coinbase via swap inline `profitToken → WETH → unwrap → transfer`.
    ///         Quando profitToken == WETH, skipa o swap (só unwrap + transfer).
    /// @dev Retorna (bribeNativeWei, profitTokenConsumed) — quanto WETH foi transferido pro
    ///      coinbase e quanto do `grossProfit` em profitToken foi consumido pra fazer isso.
    ///      Quando bribeBps == 0 e minBribeWei == 0, retorna (0, 0) sem fazer nada.
    function _payBribe(
        address profitToken,
        uint256 grossProfit,
        BribeConfig memory bribe,
        OperationType opType,
        address operator
    ) internal returns (uint256 bribeNativeWei, uint256 profitTokenConsumed) {
        // Sem bribe configurado → no-op
        if (bribe.bribeBps == 0 && bribe.minBribeWei == 0) {
            return (0, 0);
        }

        // Clamp bribeBps contra bribeMaxBps (proteção runtime — bot pode passar valor agressivo
        // mas o contrato trunca pro cap configurado).
        uint256 effectiveBps = bribe.bribeBps > bribe.bribeMaxBps ? bribe.bribeMaxBps : bribe.bribeBps;

        // Calcula bribe em profitToken: profit * bps / 10000, com floor minBribeWei (em NATIVE).
        // Como minBribeWei é em native (WETH unwrap), precisamos converter via swap quote.
        // Pra simplificar: bribeProfitTarget = grossProfit * effectiveBps / 10000 (em profitToken).
        // Se isso swap-results em algo abaixo do minBribeWei (native), elevamos depois.
        uint256 bribeProfitTarget = (grossProfit * effectiveBps) / 10_000;

        // Hard guard: bribe não pode exceder profit
        if (bribeProfitTarget == 0 && bribe.minBribeWei == 0) return (0, 0);
        if (bribeProfitTarget >= grossProfit) revert BribeExceedsProfit(bribeProfitTarget, grossProfit);

        // Fast path: profitToken == WETH → só unwrap + transfer (sem swap)
        if (profitToken == weth) {
            if (weth == address(0)) revert WethNotConfigured();
            // Se bribeProfitTarget < minBribeWei, eleva (desde que cabe no profit)
            uint256 bribeWeth = bribeProfitTarget < bribe.minBribeWei ? bribe.minBribeWei : bribeProfitTarget;
            if (bribeWeth >= grossProfit) revert BribeExceedsProfit(bribeWeth, grossProfit);
            // Unwrap WETH → ETH dentro deste contrato (recebe via receive())
            IWETH9(weth).withdraw(bribeWeth);
            _transferBribeToCoinbase(bribeWeth, opType, operator, grossProfit, grossProfit - bribeWeth);
            return (bribeWeth, bribeWeth);
        }

        // Slow path: swap inline profitToken → WETH via UniV3
        if (weth == address(0)) revert WethNotConfigured();
        if (uniV3SwapRouter == address(0)) revert SwapRouterNotConfigured();
        if (bribe.swapFeeTier == 0) revert InvalidBribeConfig();

        // Approve swap router
        IERC20(profitToken).forceApprove(uniV3SwapRouter, bribeProfitTarget);

        // Slippage min: aceitamos no mínimo (1 - swapSlippageBps/10000) do quote ideal.
        // Como não temos quote on-chain barato, usamos slippage como % do amountIn.
        // ⚠️ Limitação: sem quoter integrado, minOut é estimado conservadoramente. Bot
        //    deve simular off-chain e passar swapSlippageBps adequado. Pra MVP, set
        //    minOut = 0 e confiamos no `BribeExceedsProfit` + `minBribeWei` floor.
        uint256 wethReceived;
        try IUniV3SwapRouter(uniV3SwapRouter).exactInputSingle(
            IUniV3SwapRouter.ExactInputSingleParams({
                tokenIn: profitToken,
                tokenOut: weth,
                fee: bribe.swapFeeTier,
                recipient: address(this),
                amountIn: bribeProfitTarget,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256 out) {
            wethReceived = out;
        } catch {
            // Reset approve antes de propagar
            IERC20(profitToken).forceApprove(uniV3SwapRouter, 0);
            revert BribeSwapFailed();
        }

        // Reset approve
        IERC20(profitToken).forceApprove(uniV3SwapRouter, 0);

        // Floor minBribeWei: se swap rendeu menos que o piso, é leilão muito caro pra ser viável
        // com esse profit. Em vez de inflar bribe (que já consumiu profitToken), revertemos —
        // bot deve ter passado bribeBps maior pra match com o piso.
        if (wethReceived < bribe.minBribeWei) revert BribeExceedsProfit(bribe.minBribeWei, wethReceived);

        // Unwrap WETH → ETH
        IWETH9(weth).withdraw(wethReceived);

        _transferBribeToCoinbase(
            wethReceived,
            opType,
            operator,
            grossProfit,
            grossProfit - bribeProfitTarget
        );

        return (wethReceived, bribeProfitTarget);
    }

    /// @dev Helper isolado pra emitir evento + transferir. Coinbase é sempre `block.coinbase`.
    function _transferBribeToCoinbase(
        uint256 bribeNativeWei,
        OperationType opType,
        address operator,
        uint256 grossProfit,
        uint256 netProfit
    ) internal {
        address payable cb = payable(block.coinbase);
        // Use call em vez de transfer pra evitar gas-stipend issues em coinbase contract
        (bool ok,) = cb.call{value: bribeNativeWei}("");
        if (!ok) revert BribeSwapFailed();
        emit BribePaid(operator, opType, cb, bribeNativeWei, grossProfit, netProfit);
    }

    // ════════ INTERNAL SWAP EXECUTOR ════════

    function _executeSwaps(SwapStep[] memory steps) internal {
        uint256 len = steps.length;
        for (uint256 i = 0; i < len;) {
            // Circuit breaker por step — cap específico do tokenIn (H-02 fix).
            uint256 effectiveAmountIn = steps[i].amountIn == 0
                ? IERC20(steps[i].tokenIn).balanceOf(address(this))
                : steps[i].amountIn;
            uint256 cap = getMaxTradeFor(steps[i].tokenIn);
            if (effectiveAmountIn > cap) {
                revert TradeTooLarge(effectiveAmountIn, cap);
            }

            // Dispatch por DEX type
            DexType dt = steps[i].dexType;
            if (dt == DexType.UniswapV3) {
                UniswapV3Lib.swap(steps[i]);
            } else if (dt == DexType.Aerodrome) {
                AerodromeLib.swap(steps[i]);
            } else {
                revert InvalidDexType(uint8(dt));
            }

            unchecked { ++i; }
        }
    }

    // ════════ ADMIN ════════

    /// @inheritdoc IZeusExecutor
    function kill() external override onlyOwner {
        if (!_killed) {
            _killed = true;
            emit Killed();
        }
    }

    /// @inheritdoc IZeusExecutor
    function revive() external override onlyOwner {
        if (_killed) {
            _killed = false;
            emit Revived();
        }
    }

    /// @inheritdoc IZeusExecutor
    function isKilled() external view override returns (bool) {
        return _killed;
    }

    /// @inheritdoc IZeusExecutor
    function setMaxTradeWei(uint256 newMax) external override onlyOwner {
        emit MaxTradeWeiUpdated(maxTradeWei, newMax);
        maxTradeWei = newMax;
    }

    /// @inheritdoc IZeusExecutor
    function setMaxTradePerToken(address token, uint256 newMax) external override onlyOwner {
        if (token == address(0)) revert NotAuthorized();
        emit MaxTradePerTokenUpdated(token, _maxTradePerToken[token], newMax);
        _maxTradePerToken[token] = newMax;
    }

    /// @inheritdoc IZeusExecutor
    function getMaxTradeFor(address token) public view override returns (uint256) {
        uint256 override_ = _maxTradePerToken[token];
        return override_ != 0 ? override_ : maxTradeWei;
    }

    /// @inheritdoc IZeusExecutor
    function setOperator(address operator, bool allowed) external override onlyOwner {
        _operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    /// @inheritdoc IZeusExecutor
    function isOperator(address account) external view override returns (bool) {
        return _operators[account];
    }

    /// @inheritdoc IZeusExecutor
    function rescueToken(address token, uint256 amount, address to) external override onlyOwner {
        if (to == address(0)) revert NotAuthorized();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, amount, to);
    }

    /// @inheritdoc IZeusExecutor
    function setWeth(address newWeth) external override onlyOwner {
        weth = newWeth;
    }

    /// @inheritdoc IZeusExecutor
    function setUniV3SwapRouter(address newRouter) external override onlyOwner {
        uniV3SwapRouter = newRouter;
    }

    // ════════ PAUSABLE (extra layer além do kill switch) ════════

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ════════ RECEIVE ETH ════════

    /// @notice Permite receber ETH (necessário pra alguns swaps via WETH)
    receive() external payable {}
}
