// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SwapStep, DexType, FlashSource} from "./IZeusExecutor.sol";
import {BribeConfig} from "./IBribeManager.sol";

/// @notice Parâmetros de uma operação de liquidação Aave V3 (mantida idêntica ao v6/v7 pra compat).
struct LiquidationParams {
    address user;
    address collateralAsset;
    address debtAsset;
    uint256 debtToCover;
    SwapStep[] swapSteps;
    uint256 minProfitWei;
    address profitReceiver;
    FlashSource flashSource; // fonte do flashloan (0 = Aave, default legado)
}

struct CompoundLiquidationParams {
    address comet;
    address borrower;
    address collateralAsset;
    uint256 baseAmount;
    uint256 minCollateralReceived;
    SwapStep[] swapSteps;
    uint256 minProfitWei;
    address profitReceiver;
    FlashSource flashSource; // fonte do flashloan (0 = Aave, default legado)
}

struct MorphoLiquidationParams {
    address morpho;
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
    address borrower;
    uint256 seizedAssets;
    uint256 repaidShares;
    uint256 flashloanAmount;
    SwapStep[] swapSteps;
    uint256 minProfitWei;
    address profitReceiver;
    FlashSource flashSource; // fonte do flashloan (0 = Aave, default legado)
}

/// @notice Discriminator interno pro callback executeOperation.
enum LiquidatorOpType {
    Aave,
    AaveWithBribe,
    Compound,
    CompoundWithBribe,
    Morpho,
    MorphoWithBribe
}

/// @title IZeusLiquidator — interface do contrato dedicado a liquidations.
/// @notice Substituiu a parte de liquidations do ZeusExecutor v7. Cada protocolo tem
///         2 variantes: sem bribe (v6 fluxo) + com bribe (v7 fluxo).
interface IZeusLiquidator {
    // ════════ EVENTS ════════

    event LiquidationExecuted(
        address indexed initiator,
        address indexed user,
        address indexed collateralAsset,
        address debtAsset,
        uint256 debtCovered,
        uint256 collateralReceived,
        uint256 profit
    );

    event CompoundLiquidationExecuted(
        address indexed initiator,
        address indexed comet,
        address indexed borrower,
        address collateralAsset,
        uint256 baseAmount,
        uint256 collateralReceived,
        uint256 profit
    );

    event MorphoLiquidationExecuted(
        address indexed initiator,
        address indexed borrower,
        address indexed collateralToken,
        address loanToken,
        uint256 assetsLiquidated,
        uint256 collateralReceived,
        uint256 profit
    );

    event Killed();
    event Revived();
    event MaxTradeWeiUpdated(uint256 oldValue, uint256 newValue);
    event MaxTradePerTokenUpdated(address indexed token, uint256 oldValue, uint256 newValue);
    event OperatorSet(address indexed operator, bool allowed);
    event TokenRescued(address indexed token, uint256 amount, address indexed to);

    // ════════ ERRORS ════════

    error NotAuthorized();
    error BotKilled();
    error InsufficientProfit(uint256 actual, uint256 required);
    error InvalidDexType(uint8 dexType);
    error FlashloanRepayShortfall(uint256 available, uint256 required);
    error TradeTooLarge(uint256 amount, uint256 max);
    error EmptySteps();
    error InvalidCaller();

    // ════════ ENTRYPOINTS — sem bribe (v6 fluxo) ════════

    function executeLiquidation(LiquidationParams calldata params) external;
    function executeCompoundLiquidation(CompoundLiquidationParams calldata params) external;
    function executeMorphoLiquidation(MorphoLiquidationParams calldata params) external;

    // ════════ ENTRYPOINTS — com bribe (v7 fluxo) ════════

    function executeLiquidationWithBribe(LiquidationParams calldata params, BribeConfig calldata bribe) external;
    function executeCompoundLiquidationWithBribe(CompoundLiquidationParams calldata params, BribeConfig calldata bribe) external;
    function executeMorphoLiquidationWithBribe(MorphoLiquidationParams calldata params, BribeConfig calldata bribe) external;

    // ════════ ADMIN ════════

    function kill() external;
    function revive() external;
    function isKilled() external view returns (bool);

    function setMaxTradeWei(uint256 newMax) external;
    function maxTradeWei() external view returns (uint256);
    function setMaxTradePerToken(address token, uint256 newMax) external;
    function getMaxTradeFor(address token) external view returns (uint256);

    function setOperator(address operator, bool allowed) external;
    function isOperator(address account) external view returns (bool);

    function rescueToken(address token, uint256 amount, address to) external;

    function setWeth(address weth) external;
    function weth() external view returns (address);
    function setUniV3SwapRouter(address swapRouter) external;
    function uniV3SwapRouter() external view returns (address);
}
