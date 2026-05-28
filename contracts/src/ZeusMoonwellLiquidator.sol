// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IZeusMoonwellLiquidator, MoonwellLiquidationParams} from "./interfaces/IZeusMoonwellLiquidator.sol";
import {SwapStep, DexType} from "./interfaces/IZeusExecutor.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/aave/IFlashLoanSimpleReceiver.sol";
import {IPool} from "./interfaces/aave/IPool.sol";
import {IMToken} from "./interfaces/moonwell/IMoonwell.sol";
import {UniswapV3Lib} from "./libraries/UniswapV3Lib.sol";
import {AerodromeLib} from "./libraries/AerodromeLib.sol";

/// @title ZeusMoonwellLiquidator — liquidations Moonwell (Compound V2 fork).
/// @notice Contrato SEPARADO do ZeusLiquidator por EIP-170 (ZeusLiquidator já em 77%).
///         Moonwell usa mTokens + liquidateBorrow + redeem (mecânica Compound V2),
///         distinta de Aave/Compound III/Morpho.
/// @dev Mesmos princípios de segurança do ZeusLiquidator:
///   - Atomic-only (flashloan Aave V3 + tudo num callback)
///   - Self-custody com circuit breakers (kill + maxTrade + minProfit obrigatório)
///   - Owner = multisig em produção · Sem proxy upgradeable
///   - v1 SEM bribe (igual Compound III/Morpho atual) — adicionar depois se necessário
contract ZeusMoonwellLiquidator is IZeusMoonwellLiquidator, IFlashLoanSimpleReceiver, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable AAVE_V3_POOL;
    uint256 public maxTradeWei;
    mapping(address => uint256) private _maxTradePerToken;
    mapping(address => bool) private _operators;
    bool private _killed;

    modifier onlyOperator() {
        if (!_operators[msg.sender]) revert NotAuthorized();
        _;
    }

    modifier whenAlive() {
        if (_killed) revert Killed_();
        _;
    }

    constructor(address aaveV3Pool, address initialOwner, uint256 initialMaxTradeWei) Ownable(initialOwner) {
        if (aaveV3Pool == address(0) || initialOwner == address(0)) revert NotAuthorized();
        AAVE_V3_POOL = aaveV3Pool;
        maxTradeWei = initialMaxTradeWei;
        _killed = true;
        emit Killed();
    }

    // ════════ ENTRYPOINT ════════

    /// @inheritdoc IZeusMoonwellLiquidator
    function executeMoonwellLiquidation(MoonwellLiquidationParams calldata params)
        external
        override
        onlyOperator
        whenAlive
        nonReentrant
    {
        _validate(params);
        uint256 cap = getMaxTradeFor(params.borrowedUnderlying);
        if (params.flashloanAmount > cap) revert TradeTooLarge(params.flashloanAmount, cap);

        uint256 loanBalanceBefore = IERC20(params.borrowedUnderlying).balanceOf(address(this));
        bytes memory encoded = abi.encode(params, msg.sender, loanBalanceBefore);
        IPool(AAVE_V3_POOL).flashLoanSimple(
            address(this), params.borrowedUnderlying, params.flashloanAmount, encoded, 0
        );
    }

    // ════════ AAVE V3 FLASHLOAN CALLBACK ════════

    /// @inheritdoc IFlashLoanSimpleReceiver
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != AAVE_V3_POOL) revert InvalidCaller();
        if (initiator != address(this)) revert InvalidCaller();

        (MoonwellLiquidationParams memory mp, address operator, uint256 loanBalanceBefore) =
            abi.decode(params, (MoonwellLiquidationParams, address, uint256));

        if (asset != mp.borrowedUnderlying) revert InvalidCaller();

        uint256 collateralBefore = IERC20(mp.collateralUnderlying).balanceOf(address(this));

        // 1. Aprova mTokenBorrowed pra puxar repayAmount do underlying borrowed
        IERC20(mp.borrowedUnderlying).forceApprove(mp.mTokenBorrowed, mp.repayAmount);

        // 2. liquidateBorrow: paga dívida, recebe mTokens do collateral (cTokens seizados)
        uint256 errLiq = IMToken(mp.mTokenBorrowed).liquidateBorrow(
            mp.borrower, mp.repayAmount, mp.mTokenCollateral
        );
        if (errLiq != 0) revert LiquidationFailed(errLiq);

        IERC20(mp.borrowedUnderlying).forceApprove(mp.mTokenBorrowed, 0);

        // 3. Redeem dos mTokens de collateral seizados → underlying collateral
        uint256 seizedMTokens = IMToken(mp.mTokenCollateral).balanceOf(address(this));
        if (seizedMTokens == 0) revert InsufficientProfit(0, 1);
        uint256 errRedeem = IMToken(mp.mTokenCollateral).redeem(seizedMTokens);
        if (errRedeem != 0) revert RedeemFailed(errRedeem);

        uint256 collateralReceived = IERC20(mp.collateralUnderlying).balanceOf(address(this)) - collateralBefore;
        if (collateralReceived == 0) revert InsufficientProfit(0, 1);

        // 4. Swap collateral → borrowed
        if (mp.swapSteps.length > 0) _executeSwaps(mp.swapSteps);

        // 5. Valida repagamento do flashloan + profit floor
        uint256 amountOwed = amount + premium;
        uint256 loanBalance = IERC20(mp.borrowedUnderlying).balanceOf(address(this));
        uint256 minRequiredBalance = amountOwed + loanBalanceBefore;
        if (loanBalance < minRequiredBalance) revert FlashloanRepayShortfall(loanBalance, minRequiredBalance);

        uint256 grossProfit = loanBalance - amountOwed - loanBalanceBefore;
        if (grossProfit < mp.minProfitWei) revert InsufficientProfit(grossProfit, mp.minProfitWei);

        if (mp.profitReceiver != address(this) && grossProfit > 0) {
            IERC20(mp.borrowedUnderlying).safeTransfer(mp.profitReceiver, grossProfit);
        }

        emit MoonwellLiquidationExecuted(
            operator, mp.borrower, mp.mTokenCollateral, mp.borrowedUnderlying,
            mp.repayAmount, collateralReceived, grossProfit
        );

        // 6. Aprova Aave pra puxar amount + premium de volta
        IERC20(asset).forceApprove(AAVE_V3_POOL, amountOwed);
        return true;
    }

    // ════════ INTERNAL ════════

    function _validate(MoonwellLiquidationParams calldata p) internal pure {
        if (p.mTokenBorrowed == address(0) || p.borrowedUnderlying == address(0)) revert NotAuthorized();
        if (p.mTokenCollateral == address(0) || p.collateralUnderlying == address(0)) revert NotAuthorized();
        if (p.borrower == address(0) || p.profitReceiver == address(0)) revert NotAuthorized();
        if (p.repayAmount == 0 || p.flashloanAmount == 0) revert EmptySteps();
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

    function kill() external override onlyOwner {
        if (!_killed) { _killed = true; emit Killed(); }
    }

    function revive() external override onlyOwner {
        if (_killed) { _killed = false; emit Revived(); }
    }

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

    receive() external payable {}
}
