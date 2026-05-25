// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

/// @title IComet — interface mínima do Compound III (Comet) pra liquidations
/// @notice Inclui apenas funções que o ZeusExecutor usa
/// @dev Compound III tem fluxo de liquidação em 2 passos (atômicos via flashloan):
///      1. `absorb(absorber, accounts)` — protocolo absorve a position underwater
///      2. `buyCollateral(asset, minAmount, baseAmount, recipient)` — compra collateral com desconto
///      O profit vem do desconto que o Comet aplica em buyCollateral (similar ao bonus do Aave)
interface IComet {
    /// @notice Absorver positions underwater — qualquer um pode chamar
    /// @param absorber endereço que recebe "pontos" pra reembolso de gas futuro
    /// @param accounts array de borrowers a serem absorbed
    function absorb(address absorber, address[] calldata accounts) external;

    /// @notice Comprar collateral do protocolo com desconto, usando base token
    /// @param asset endereço do collateral a comprar
    /// @param minAmount min de collateral a receber (slippage protection)
    /// @param baseAmount quantidade do base token a gastar
    /// @param recipient endereço que recebe o collateral
    function buyCollateral(
        address asset,
        uint256 minAmount,
        uint256 baseAmount,
        address recipient
    ) external;

    /// @notice Cotar quanto collateral é recebido pra X base tokens
    /// @param asset collateral asset
    /// @param baseAmount quantidade de base token
    /// @return collateralAmount quanto receberia (com desconto já aplicado)
    function quoteCollateral(address asset, uint256 baseAmount) external view returns (uint256);

    /// @notice Verifica se uma position é liquidável agora
    /// @param account borrower
    /// @return true se HF < 1 (pode ser absorbed)
    function isLiquidatable(address account) external view returns (bool);

    /// @notice Base token do market (USDC, WETH, etc — depende do Comet)
    function baseToken() external view returns (address);

    /// @notice Saldo atual de base token de um account (debt ou supply)
    /// @return saldo signed: positivo = supplying, negativo = borrowing
    function balanceOf(address account) external view returns (uint256);

    /// @notice Saldo de uma reserve específica (collateral) de um account
    function collateralBalanceOf(address account, address asset) external view returns (uint128);

    /// @notice Endereço do PriceFeed pra um asset
    function getAssetInfoByAddress(address asset) external view returns (
        uint8 offset,
        address assetAddr,
        address priceFeed,
        uint64 scale,
        uint64 borrowCollateralFactor,
        uint64 liquidateCollateralFactor,
        uint64 liquidationFactor,
        uint128 supplyCap
    );
}
