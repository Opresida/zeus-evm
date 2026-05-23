// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

/// @title IPool — interface mínima do Aave V3 Pool para flashloans
/// @notice Inclui apenas as funções que o ZeusExecutor utiliza
/// @dev Endereço Base mainnet: 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
///      Endereço Base Sepolia:  0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b
interface IPool {
    /// @notice Inicia um flashloan single-asset
    /// @param receiverAddress contrato que implementa IFlashLoanSimpleReceiver
    /// @param asset endereço do ERC20 a ser emprestado
    /// @param amount quantidade a emprestar (em wei do asset)
    /// @param params dados arbitrários passados pro callback executeOperation
    /// @param referralCode 0 — sem programa de referral
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @notice Liquida uma posição com Health Factor < 1
    /// @param collateralAsset asset que receberemos como collateral
    /// @param debtAsset asset cuja dívida estamos quitando
    /// @param user dono da posição under-collateralized
    /// @param debtToCover quantia da dívida a cobrir
    /// @param receiveAToken true=recebe aToken, false=recebe asset crú
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

    /// @notice Retorna dados agregados da position de um user
    /// @dev Usado pelo monitor off-chain pra HF check real-time
    /// @return totalCollateralBase Total collateral em base currency (USD com 8 decimais)
    /// @return totalDebtBase Total debt em base currency
    /// @return availableBorrowsBase Quanto ainda pode emprestar
    /// @return currentLiquidationThreshold Threshold ponderado da position (1e4 = 100%)
    /// @return ltv Loan-to-Value (1e4 = 100%)
    /// @return healthFactor 1e18 = HF 1.0; < 1e18 = liquidável
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );
}
