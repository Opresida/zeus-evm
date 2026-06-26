// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SwapStep} from "./IZeusExecutor.sol";

/// @notice Parâmetros de uma PRÉ-liquidação Morpho (modo callback+swap, atômico, sem flashloan).
/// @dev Doutrina inegociável: SEMPRE vende o colateral seizado → loanToken (stable) e fica com o surplus
///      em stablecoin. NÃO existe modo inventário (reter colateral) — `swapSteps` é OBRIGATÓRIO.
struct PreMorphoLiquidationParams {
    address preLiquidation; // contrato PreLiquidation por-mercado (DEVE estar na whitelist)
    address loanToken; // token da dívida (stable) — onde o lucro fica
    address collateralToken; // colateral seizado (vendido 100% → loanToken)
    address borrower; // dono da posição pré-liquidável
    uint256 seizedAssets; // modo por-seized (0 se usar repaidShares)
    uint256 repaidShares; // modo por-shares (0 se usar seizedAssets)
    SwapStep[] swapSteps; // OBRIGATÓRIO: colateral → loanToken. Vazio = revert (sem inventário)
    uint256 minProfitWei; // lucro mínimo em loanToken (stable) ou a tx reverte
    address profitReceiver; // pra onde mandar o surplus em loanToken
}

/// @title IZeusMorphoPreLiquidator — pré-liquidação Morpho (contrato satélite, EIP-170-safe).
interface IZeusMorphoPreLiquidator {
    // ════════ EVENTS ════════

    event PreMorphoLiquidationExecuted(
        address indexed initiator,
        address indexed preLiquidation,
        address indexed borrower,
        address loanToken,
        uint256 repaidAssets,
        uint256 profit
    );

    event Killed();
    event Revived();
    event OperatorSet(address indexed operator, bool allowed);
    event ApprovedPreLiquidationSet(address indexed preLiquidation, bool allowed);
    event MaxTradeWeiUpdated(uint256 oldValue, uint256 newValue);
    event MaxTradePerTokenUpdated(address indexed token, uint256 oldValue, uint256 newValue);
    event TokenRescued(address indexed token, uint256 amount, address indexed to);

    // ════════ CUSTOM ERRORS ════════

    error NotAuthorized();
    error BotKilled();
    error InvalidCaller();
    error InsufficientProfit(uint256 actual, uint256 required);
    error InvalidDexType(uint8 dexType);
    error TradeTooLarge(uint256 amount, uint256 max);
    error EmptySwapSteps();
    /// @notice O contrato PreLiquidation não está na whitelist (default-deny).
    error NotApprovedPreLiquidation(address preLiquidation);

    // ════════ ENTRYPOINT ════════

    /// @notice Executa uma pré-liquidação: chama `preLiquidate` no contrato PreLiquidation (whitelisted),
    ///         que entrega o colateral e dispara `onPreLiquidate` (onde vendemos → loanToken e aprovamos o
    ///         repay). Atômico: reverte tudo se o lucro líquido em loanToken < `minProfitWei`.
    function executePreMorphoLiquidation(PreMorphoLiquidationParams calldata params) external;

    // ════════ ADMIN (owner only) ════════

    function kill() external;
    function revive() external;
    function isKilled() external view returns (bool);

    function setOperator(address operator, bool allowed) external;
    function isOperator(address account) external view returns (bool);

    /// @notice Whitelist (default-deny) de contratos PreLiquidation que podem chamar nosso callback.
    function setApprovedPreLiquidation(address preLiquidation, bool allowed) external;
    function isApprovedPreLiquidation(address preLiquidation) external view returns (bool);

    function setMaxTradeWei(uint256 newMax) external;
    function maxTradeWei() external view returns (uint256);
    function setMaxTradePerToken(address token, uint256 newMax) external;
    function getMaxTradeFor(address token) external view returns (uint256);

    function rescueToken(address token, uint256 amount, address to) external;
}
