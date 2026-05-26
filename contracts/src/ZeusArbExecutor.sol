// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IZeusArbExecutor, BackrunParams, ArbOpType} from "./interfaces/IZeusArbExecutor.sol";
import {SwapStep, ArbitrageParams, DexType} from "./interfaces/IZeusExecutor.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/aave/IFlashLoanSimpleReceiver.sol";
import {IPool} from "./interfaces/aave/IPool.sol";
import {UniswapV3Lib} from "./libraries/UniswapV3Lib.sol";
import {AerodromeLib} from "./libraries/AerodromeLib.sol";
import {IBribeManager, BribeConfig} from "./interfaces/IBribeManager.sol";

/// @title ZeusArbExecutor — contrato dedicado a arbitragens cross-DEX + backrun.
/// @notice Refatoração v8 (sucessor da parte arb do ZeusExecutor v7).
///         3 fluxos: arb wallet, arb flashloan, backrun com bribe.
contract ZeusArbExecutor is IZeusArbExecutor, IFlashLoanSimpleReceiver, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable AAVE_V3_POOL;
    /// @notice BribeManager standalone — paga bribe ao block.coinbase em FlashloanBackrun.
    /// @dev Imutável após deploy. Compartilhado com ZeusLiquidator (1 BribeManager, 2 consumidores).
    address public immutable BRIBE_MANAGER;
    uint256 public maxTradeWei;
    mapping(address => uint256) private _maxTradePerToken;
    mapping(address => bool) private _operators;
    bool private _killed;

    address public weth;
    address public uniV3SwapRouter;

    constructor(
        address aaveV3Pool,
        address bribeManager,
        address initialOwner,
        uint256 initialMaxTradeWei
    ) Ownable(initialOwner) {
        if (aaveV3Pool == address(0) || initialOwner == address(0)) revert NotAuthorized();
        if (bribeManager == address(0)) revert NotAuthorized();
        AAVE_V3_POOL = aaveV3Pool;
        BRIBE_MANAGER = bribeManager;
        maxTradeWei = initialMaxTradeWei;
        _killed = true;
        emit Killed();
    }

    function _callBribeManager(
        address profitToken,
        uint256 grossProfit,
        BribeConfig memory bribe,
        IBribeManager.BribeOpType opType,
        address operator
    ) internal returns (uint256 bribeNativeWei, uint256 profitConsumed) {
        IERC20(profitToken).forceApprove(BRIBE_MANAGER, type(uint256).max);
        (bribeNativeWei, profitConsumed) = IBribeManager(BRIBE_MANAGER).pay(
            profitToken, grossProfit, bribe, weth, uniV3SwapRouter, opType, operator
        );
        IERC20(profitToken).forceApprove(BRIBE_MANAGER, 0);
    }

    modifier onlyOperator() {
        if (msg.sender != owner() && !_operators[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier whenAlive() {
        if (_killed) revert BotKilled();
        _;
    }

    // ════════ ENTRYPOINTS ════════

    /// @inheritdoc IZeusArbExecutor
    function executeArbitrage(ArbitrageParams calldata params)
        external
        override
        onlyOperator
        
        whenAlive
        nonReentrant
    {
        if (params.steps.length == 0) revert EmptySteps();
        if (params.profitToken == address(0)) revert NotAuthorized();
        if (params.profitReceiver == address(0)) revert NotAuthorized();

        uint256 balanceBefore = IERC20(params.profitToken).balanceOf(address(this));
        _executeSwaps(params.steps);

        uint256 balanceAfter = IERC20(params.profitToken).balanceOf(address(this));
        if (balanceAfter < balanceBefore + params.minProfitWei) {
            revert InsufficientProfit(
                balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0,
                params.minProfitWei
            );
        }

        uint256 profit = balanceAfter - balanceBefore;
        if (params.profitReceiver != address(this) && profit > 0) {
            IERC20(params.profitToken).safeTransfer(params.profitReceiver, profit);
        }

        emit ArbitrageExecuted(msg.sender, params.profitToken, profit, params.steps.length);
    }

    /// @inheritdoc IZeusArbExecutor
    function executeFlashloanArbitrage(
        address flashloanAsset,
        uint256 flashloanAmount,
        ArbitrageParams calldata params
    ) external override onlyOperator  whenAlive nonReentrant {
        if (params.steps.length == 0) revert EmptySteps();
        if (params.profitToken == address(0)) revert NotAuthorized();
        if (params.profitReceiver == address(0)) revert NotAuthorized();
        if (flashloanAsset == address(0)) revert NotAuthorized();

        uint256 cap = getMaxTradeFor(flashloanAsset);
        if (flashloanAmount > cap) revert TradeTooLarge(flashloanAmount, cap);

        bytes memory encoded = abi.encode(
            ArbOpType.FlashloanArbitrage,
            abi.encode(params, msg.sender)
        );
        IPool(AAVE_V3_POOL).flashLoanSimple(address(this), flashloanAsset, flashloanAmount, encoded, 0);
    }

    /// @inheritdoc IZeusArbExecutor
    function executeFlashloanBackrun(
        address flashloanAsset,
        uint256 flashloanAmount,
        BackrunParams calldata params
    ) external override onlyOperator  whenAlive nonReentrant {
        if (params.steps.length == 0) revert EmptySteps();
        if (params.profitReceiver == address(0)) revert NotAuthorized();
        if (params.profitToken == address(0)) revert NotAuthorized();
        if (flashloanAsset == address(0)) revert NotAuthorized();
        IBribeManager(BRIBE_MANAGER).validateConfig(params.bribe);

        uint256 cap = getMaxTradeFor(flashloanAsset);
        if (flashloanAmount > cap) revert TradeTooLarge(flashloanAmount, cap);

        bytes memory encoded = abi.encode(
            ArbOpType.FlashloanBackrun,
            abi.encode(params, msg.sender)
        );
        IPool(AAVE_V3_POOL).flashLoanSimple(address(this), flashloanAsset, flashloanAmount, encoded, 0);
    }

    // ════════ AAVE V3 FLASHLOAN CALLBACK ════════

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != AAVE_V3_POOL) revert InvalidCaller();
        if (initiator != address(this)) revert InvalidCaller();

        (ArbOpType opType, bytes memory inner) = abi.decode(params, (ArbOpType, bytes));

        if (opType == ArbOpType.FlashloanArbitrage) {
            _handleFlashloanArb(asset, amount, premium, inner);
        } else if (opType == ArbOpType.FlashloanBackrun) {
            _handleFlashloanBackrun(asset, amount, premium, inner);
        } else {
            revert InvalidCaller();
        }

        IERC20(asset).forceApprove(AAVE_V3_POOL, amount + premium);
        return true;
    }

    function _handleFlashloanArb(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        (ArbitrageParams memory arbParams, address operator) = abi.decode(inner, (ArbitrageParams, address));

        uint256 balanceBefore = IERC20(arbParams.profitToken).balanceOf(address(this));
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

    function _handleFlashloanBackrun(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes memory inner
    ) internal {
        (BackrunParams memory bp, address operator) = abi.decode(inner, (BackrunParams, address));

        uint256 balanceBefore = IERC20(bp.profitToken).balanceOf(address(this));
        if (bp.profitToken == asset) {
            balanceBefore = balanceBefore > amount ? balanceBefore - amount : 0;
        }

        _executeSwaps(bp.steps);

        uint256 balanceAfter = IERC20(bp.profitToken).balanceOf(address(this));
        uint256 amountOwed = amount + premium;
        uint256 assetBalance = IERC20(asset).balanceOf(address(this));
        if (assetBalance < amountOwed) revert FlashloanRepayShortfall(assetBalance, amountOwed);

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

        (uint256 bribeNativeWei, uint256 profitConsumed) = _callBribeManager(
            bp.profitToken, grossProfit, bp.bribe, IBribeManager.BribeOpType.FlashloanBackrun, operator
        );

        uint256 netProfit = grossProfit - profitConsumed;
        if (netProfit < bp.minProfitWei) revert InsufficientProfit(netProfit, bp.minProfitWei);

        if (bp.profitReceiver != address(this) && netProfit > 0) {
            IERC20(bp.profitToken).safeTransfer(bp.profitReceiver, netProfit);
        }

        emit BackrunExecuted(operator, asset, bp.profitToken, amount, grossProfit, bribeNativeWei, netProfit);
    }

    function _executeSwaps(SwapStep[] memory steps) internal {
        uint256 len = steps.length;
        for (uint256 i = 0; i < len;) {
            uint256 effectiveAmountIn = steps[i].amountIn == 0
                ? IERC20(steps[i].tokenIn).balanceOf(address(this))
                : steps[i].amountIn;
            uint256 cap = getMaxTradeFor(steps[i].tokenIn);
            if (effectiveAmountIn > cap) revert TradeTooLarge(effectiveAmountIn, cap);

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

    function kill() external override onlyOwner { if (!_killed) { _killed = true; emit Killed(); } }
    function revive() external override onlyOwner { if (_killed) { _killed = false; emit Revived(); } }
    function isKilled() external view override returns (bool) { return _killed; }

    function setMaxTradeWei(uint256 newMax) external override onlyOwner {
        emit MaxTradeWeiUpdated(maxTradeWei, newMax);
        maxTradeWei = newMax;
    }
    function setMaxTradePerToken(address token, uint256 newMax) external override onlyOwner {
        if (token == address(0)) revert NotAuthorized();
        emit MaxTradePerTokenUpdated(token, _maxTradePerToken[token], newMax);
        _maxTradePerToken[token] = newMax;
    }
    function getMaxTradeFor(address token) public view override returns (uint256) {
        uint256 override_ = _maxTradePerToken[token];
        return override_ != 0 ? override_ : maxTradeWei;
    }
    function setOperator(address operator, bool allowed) external override onlyOwner {
        _operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }
    function isOperator(address account) external view override returns (bool) { return _operators[account]; }
    function rescueToken(address token, uint256 amount, address to) external override onlyOwner {
        if (to == address(0)) revert NotAuthorized();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, amount, to);
    }
    function setWeth(address newWeth) external override onlyOwner { weth = newWeth; }
    function setUniV3SwapRouter(address newRouter) external override onlyOwner { uniV3SwapRouter = newRouter; }
    // pause/unpause REMOVIDOS na v8 — kill switch é o circuit breaker primário.

    receive() external payable {}
}
