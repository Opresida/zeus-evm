// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SwapStep, ArbitrageParams, DexType, FlashSource} from "./IZeusExecutor.sol";
import {BribeConfig} from "./IBribeManager.sol";

/// @notice Parâmetros do backrun de dislocation cross-DEX. Reusa SwapStep do v6.
struct BackrunParams {
    SwapStep[] steps;
    uint256 minProfitWei;
    address profitToken;
    address profitReceiver;
    BribeConfig bribe;
    FlashSource flashSource; // fonte do flashloan (0 = Aave, default legado)
}

enum ArbOpType {
    Arbitrage,
    FlashloanArbitrage,
    FlashloanBackrun
}

/// @title IZeusArbExecutor — interface do contrato dedicado a arbitragens.
/// @notice Substituiu a parte de arb/backrun do ZeusExecutor v7.
interface IZeusArbExecutor {
    // ════════ EVENTS ════════

    event ArbitrageExecuted(
        address indexed initiator,
        address indexed profitToken,
        uint256 profit,
        uint256 swapsCount
    );

    event FlashloanArbitrageExecuted(
        address indexed initiator,
        address indexed flashloanAsset,
        uint256 flashloanAmount,
        uint256 flashloanFee,
        address indexed profitToken,
        uint256 profit
    );

    event BackrunExecuted(
        address indexed initiator,
        address indexed flashloanAsset,
        address indexed profitToken,
        uint256 flashloanAmount,
        uint256 grossProfit,
        uint256 bribeNativeWei,
        uint256 netProfit
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

    // ════════ ENTRYPOINTS ════════

    function executeArbitrage(ArbitrageParams calldata params) external;
    function executeFlashloanArbitrage(
        address flashloanAsset,
        uint256 flashloanAmount,
        ArbitrageParams calldata params
    ) external;
    function executeFlashloanBackrun(
        address flashloanAsset,
        uint256 flashloanAmount,
        BackrunParams calldata params
    ) external;

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
