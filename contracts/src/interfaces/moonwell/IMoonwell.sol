// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

/// @notice Moonwell mToken (fork do Compound V2 cToken / MErc20).
/// @dev Em Base, todos os markets são MErc20 (underlying ERC20, sem nativo).
///      Endereços: https://docs.moonwell.fi/moonwell/protocol-information/contracts
interface IMToken {
    /// @notice Liquida uma position underwater. O liquidator paga `repayAmount` do
    ///         underlying DESTE mToken (o borrowed) e recebe mTokens do collateral.
    /// @param borrower borrower com shortfall (Comptroller.getAccountLiquidity)
    /// @param repayAmount quanto do underlying borrowed pagar (cap = closeFactor × dívida)
    /// @param mTokenCollateral mToken do colateral a seizar
    /// @return 0 em sucesso (código de erro Compound V2 caso contrário)
    function liquidateBorrow(address borrower, uint256 repayAmount, address mTokenCollateral)
        external
        returns (uint256);

    /// @notice Resgata mTokens por underlying (após seizar collateral mTokens).
    /// @param redeemTokens quantidade de mTokens a resgatar
    /// @return 0 em sucesso
    function redeem(uint256 redeemTokens) external returns (uint256);

    /// @notice Balance de mTokens (cTokens) do holder.
    function balanceOf(address owner) external view returns (uint256);

    /// @notice Underlying ERC20 deste market.
    function underlying() external view returns (address);

    /// @notice Snapshot da conta: (erro, mTokenBalance, borrowBalance, exchangeRateMantissa).
    function getAccountSnapshot(address account)
        external
        view
        returns (uint256, uint256, uint256, uint256);

    /// @notice Dívida atual do borrower neste market (com juros acumulados).
    function borrowBalanceStored(address account) external view returns (uint256);
}

/// @notice Comptroller do Moonwell (fork Compound V2 Comptroller).
/// @dev Usado off-chain pra discovery (shortfall) + parâmetros de liquidação.
interface IMoonwellComptroller {
    /// @notice Liquidez da conta: (erro, liquidity, shortfall). shortfall > 0 = liquidável.
    function getAccountLiquidity(address account)
        external
        view
        returns (uint256, uint256, uint256);

    /// @notice Close factor (1e18 scale) — máx % da dívida liquidável de uma vez.
    function closeFactorMantissa() external view returns (uint256);

    /// @notice Liquidation incentive (1e18 scale, ex: 1.08e18 = 8% bônus).
    function liquidationIncentiveMantissa() external view returns (uint256);

    /// @notice Markets em que a conta entrou (pra descobrir collateral/debt).
    function getAssetsIn(address account) external view returns (address[] memory);

    /// @notice Calcula mTokens de collateral a seizar dado um repayAmount.
    function liquidateCalculateSeizeTokens(
        address mTokenBorrowed,
        address mTokenCollateral,
        uint256 repayAmount
    ) external view returns (uint256, uint256);
}
