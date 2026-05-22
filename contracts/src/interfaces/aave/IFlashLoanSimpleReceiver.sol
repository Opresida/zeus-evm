// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

/// @title IFlashLoanSimpleReceiver
/// @notice Interface obrigatória para contratos que recebem flashloans simples do Aave V3
/// @dev Aave V3 vai chamar executeOperation() durante a flashloan
interface IFlashLoanSimpleReceiver {
    /// @notice Callback chamado pelo Aave Pool durante a flashloan
    /// @param asset endereço do asset emprestado
    /// @param amount quantia emprestada
    /// @param premium fee do Aave (0.05% típico)
    /// @param initiator endereço que originalmente chamou flashLoanSimple
    /// @param params dados arbitrários passados originalmente
    /// @return success true se a execução foi bem-sucedida
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}
