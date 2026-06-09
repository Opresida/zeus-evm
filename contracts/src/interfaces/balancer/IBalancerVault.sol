// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IBalancerVault — interface mínima do Balancer V2 Vault pra flashloans.
/// @notice Endereço canônico em todas as chains EVM (Base/Ethereum/Arbitrum/Optimism/Polygon):
///         0xBA12222222228d8Ba445958a75a0704d566BF2C8
/// @dev Flashloan a 0% de fee (flashLoanFeePercentage = 0 desde a génese do protocolo).
///      O Vault transfere `amounts[i]` de cada `tokens[i]` pro `recipient`, invoca
///      `receiveFlashLoan(...)` no recipient, e exige que ao fim do callback o recipient
///      tenha TRANSFERIDO de volta `amounts[i] + feeAmounts[i]` pro Vault (sem approve — é transfer direto).
interface IBalancerVault {
    /// @param recipient contrato que implementa IFlashLoanRecipient
    /// @param tokens lista de ERC20 a emprestar (usamos array 1-elemento)
    /// @param amounts quantidades correspondentes (wei)
    /// @param userData payload arbitrário repassado pro callback
    function flashLoan(
        address recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

/// @title IFlashLoanRecipient — callback que o tomador do flashloan Balancer deve implementar.
/// @dev 🔴 SEGURANÇA: qualquer um pode chamar `vault.flashLoan(VÍTIMA, ...)` nomeando nosso
///      contrato como recipient. O Vault invocará nosso `receiveFlashLoan` com `userData`
///      controlado pelo atacante e `msg.sender == vault` passa. A ÚNICA defesa é uma flag
///      transiente "eu iniciei isso" setada pelo entrypoint antes de chamar o Vault.
interface IFlashLoanRecipient {
    /// @param tokens mesma lista passada pro flashLoan
    /// @param amounts mesmas quantidades emprestadas
    /// @param feeAmounts fee por token (0 no Balancer V2 hoje; manter no repago por robustez)
    /// @param userData payload que o tomador passou pra flashLoan
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}
