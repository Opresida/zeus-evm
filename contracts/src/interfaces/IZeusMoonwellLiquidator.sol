// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SwapStep, FlashSource} from "./IZeusExecutor.sol";

/// @notice Params pra liquidation Moonwell (Compound V2 fork).
/// @dev Fluxo: flashloan borrowedUnderlying → liquidateBorrow → redeem mTokenCollateral
///      → swap collateral→borrowed → repay flashloan → profit.
struct MoonwellLiquidationParams {
    /// @dev mToken onde o borrower tem dívida (ex: mUSDC). underlying = borrowedUnderlying.
    address mTokenBorrowed;
    /// @dev Underlying do mTokenBorrowed (= flashloan asset).
    address borrowedUnderlying;
    /// @dev mToken do colateral a seizar (ex: mWETH).
    address mTokenCollateral;
    /// @dev Underlying do mTokenCollateral (token que sai do redeem).
    address collateralUnderlying;
    address borrower;
    /// @dev Quanto do borrowedUnderlying pagar (cap = closeFactor × dívida).
    uint256 repayAmount;
    /// @dev Flashloan necessário (= repayAmount).
    uint256 flashloanAmount;
    /// @dev Swaps collateralUnderlying → borrowedUnderlying.
    SwapStep[] swapSteps;
    uint256 minProfitWei;
    address profitReceiver;
    FlashSource flashSource; // fonte do flashloan (0 = Aave, default legado)
}

/// @title IZeusMoonwellLiquidator — interface do contrato dedicado a liquidations Moonwell.
/// @notice Contrato SEPARADO do ZeusLiquidator (EIP-170: ZeusLiquidator já em 77%).
///         Compound V2 fork tem mecânica distinta (mTokens + liquidateBorrow + redeem).
interface IZeusMoonwellLiquidator {
    event MoonwellLiquidationExecuted(
        address indexed initiator,
        address indexed borrower,
        address indexed mTokenCollateral,
        address borrowedUnderlying,
        uint256 repayAmount,
        uint256 collateralReceived,
        uint256 profit
    );
    event Killed();
    event Revived();
    event MaxTradeWeiUpdated(uint256 oldValue, uint256 newValue);
    event MaxTradePerTokenUpdated(address indexed token, uint256 oldValue, uint256 newValue);
    event OperatorSet(address indexed operator, bool allowed);
    event TokenRescued(address indexed token, uint256 amount, address indexed to);

    error NotAuthorized();
    error InvalidCaller();
    error BotKilled();
    error TradeTooLarge(uint256 requested, uint256 cap);
    error InsufficientProfit(uint256 got, uint256 min);
    error FlashloanRepayShortfall(uint256 balance, uint256 required);
    error LiquidationFailed(uint256 errorCode);
    error RedeemFailed(uint256 errorCode);
    error EmptySteps();
    error InvalidDexType(uint8 dexType);

    function executeMoonwellLiquidation(MoonwellLiquidationParams calldata params) external;

    function kill() external;
    function revive() external;
    function isKilled() external view returns (bool);
    function setMaxTradeWei(uint256 newMax) external;
    function setMaxTradePerToken(address token, uint256 newMax) external;
    function getMaxTradeFor(address token) external view returns (uint256);
    function setOperator(address operator, bool allowed) external;
    function isOperator(address account) external view returns (bool);
    function rescueToken(address token, uint256 amount, address to) external;
}
