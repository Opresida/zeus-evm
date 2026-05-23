// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IZeusExecutor, SwapStep, ArbitrageParams, LiquidationParams, DexType, OperationType} from "./interfaces/IZeusExecutor.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/aave/IFlashLoanSimpleReceiver.sol";
import {IPool} from "./interfaces/aave/IPool.sol";
import {UniswapV3Lib} from "./libraries/UniswapV3Lib.sol";
import {AerodromeLib} from "./libraries/AerodromeLib.sol";

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

    /// @notice Limite máximo de amountIn por step (circuit breaker)
    uint256 public maxTradeWei;

    /// @notice Wallets autorizadas a chamar entry points (além do owner)
    mapping(address => bool) private _operators;

    /// @notice Override do Pausable pra UX clara via boolean dedicado
    bool private _killed;

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
        if (flashloanAmount > maxTradeWei) revert TradeTooLarge(flashloanAmount, maxTradeWei);

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
        if (params.debtToCover > maxTradeWei) revert TradeTooLarge(params.debtToCover, maxTradeWei);

        // Encoda discriminator + liquidation params + operator
        bytes memory encodedParams = abi.encode(OperationType.Liquidation, abi.encode(params, msg.sender));

        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this),
            params.debtAsset,
            params.debtToCover,
            encodedParams,
            0
        );
        // Aave chama executeOperation aqui — _handleLiquidation roda lá dentro
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
        (LiquidationParams memory liqParams, address operator) = abi.decode(inner, (LiquidationParams, address));

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

        // 4. Validar capacidade de repay (saldo de debtAsset >= flashloan + premium)
        uint256 amountOwed = amount + premium;
        uint256 debtAssetBalance = IERC20(liqParams.debtAsset).balanceOf(address(this));
        if (debtAssetBalance < amountOwed) revert FlashloanRepayShortfall(debtAssetBalance, amountOwed);

        // 5. Calcular profit líquido em debtAsset (após repay)
        uint256 profit = debtAssetBalance - amountOwed;
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

    // ════════ INTERNAL SWAP EXECUTOR ════════

    function _executeSwaps(SwapStep[] memory steps) internal {
        uint256 len = steps.length;
        for (uint256 i = 0; i < len;) {
            // Circuit breaker por step
            uint256 effectiveAmountIn = steps[i].amountIn == 0
                ? IERC20(steps[i].tokenIn).balanceOf(address(this))
                : steps[i].amountIn;
            if (effectiveAmountIn > maxTradeWei) {
                revert TradeTooLarge(effectiveAmountIn, maxTradeWei);
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
