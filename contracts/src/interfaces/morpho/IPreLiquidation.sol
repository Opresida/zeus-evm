// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {MarketParams} from "./IMorpho.sol";

/// @notice Parâmetros imutáveis de um contrato PreLiquidation (escala WAD).
/// @dev Espelha `morpho-org/pre-liquidation` (`IPreLiquidation.PreLiquidationParams`).
///   - preLltv: LTV máximo da posição antes de permitir pré-liquidação.
///   - preLCF1/preLCF2: close factor no preLltv / no LLTV (interpola linear).
///   - preLIF1/preLIF2: incentive factor no preLltv / no LLTV (interpola linear).
///   - preLiquidationOracle: oráculo usado pra avaliar a pré-liquidação (PODE diferir do market oracle).
struct PreLiquidationParams {
    uint256 preLltv;
    uint256 preLCF1;
    uint256 preLCF2;
    uint256 preLIF1;
    uint256 preLIF2;
    address preLiquidationOracle;
}

/// @title IPreLiquidation — contrato PreLiquidation por-mercado do Morpho.
/// @notice Confirmado on-chain na Fase 0 (Base factory `0x8cd16b62E170Ee0bA83D80e1F80E6085367e2aef`).
///         Fluxo: chamamos `preLiquidate` → ele saca o colateral pra nós + chama nosso
///         `onPreLiquidate` (dentro do `onMorphoRepay`) → cobramos via `transferFrom` (precisamos
///         ter aprovado o loanToken PRO PRÓPRIO contrato PreLiquidation, não pro Morpho singleton).
interface IPreLiquidation {
    /// @param borrower dono da posição pré-liquidável.
    /// @param seizedAssets colateral a seizar (passe 0 se usar repaidShares).
    /// @param repaidShares shares de dívida a fechar (passe 0 se usar seizedAssets).
    /// @param data passado ao callback `onPreLiquidate`. Vazio = sem callback (modo inventário — NÃO usamos).
    /// @return seizedAssets / repaidAssets efetivos.
    function preLiquidate(address borrower, uint256 seizedAssets, uint256 repaidShares, bytes calldata data)
        external
        returns (uint256, uint256);

    /// @notice Config imutável (usada pela discovery off-chain — Fase 3).
    function preLiquidationParams() external view returns (PreLiquidationParams memory);

    /// @notice Market params do Morpho (loanToken/collateralToken/oracle/irm/lltv).
    function marketParams() external returns (MarketParams memory);
}

/// @title IPreLiquidationCallback — implementado pelo liquidador (nosso `ZeusMorphoPreLiquidator`).
/// @notice O contrato PreLiquidation chama isto APÓS nos entregar o colateral e ANTES de cobrar a dívida.
interface IPreLiquidationCallback {
    /// @param repaidAssets quantidade de loanToken que o PreLiquidation vai puxar de nós (via transferFrom).
    /// @param data o que passamos em `preLiquidate` (aqui: abi.encode(loanToken, SwapStep[])).
    function onPreLiquidate(uint256 repaidAssets, bytes calldata data) external;
}
