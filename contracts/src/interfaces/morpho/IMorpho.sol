// SPDX-License-Identifier: AGPL-3.0
pragma solidity ^0.8.0;

/// @notice MarketParams identifica unicamente um market Morpho Blue (markets são isolados)
/// @dev Hash dos 5 campos = market id (bytes32)
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;          // interest rate model
    uint256 lltv;         // liquidation LTV (1e18 scale, ex: 0.86e18 = 86%)
}

/// @notice Position do user em um market específico
struct Position {
    uint256 supplyShares;     // shares de supply (não usado na nossa estratégia)
    uint128 borrowShares;     // shares de empréstimo
    uint128 collateral;       // colateral depositado (em wei do collateralToken)
}

/// @notice Estado agregado do market (totalSupplyAssets, totalBorrowAssets, etc)
struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

/// @title IMorpho — interface mínima do Morpho Blue (singleton) pra liquidations
/// @notice Endereço em todas chains suportadas: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
/// @dev Em 2026 ATIVO em Base + Ethereum mainnet. Arb/OP/Polygon são "infrastructure mode" sem volume real.
interface IMorpho {
    /// @notice Liquida position underwater em um market específico
    /// @param marketParams identifica o market (collateral/loan/oracle/irm/lltv)
    /// @param borrower endereço do borrower com HF < 1
    /// @param seizedAssets quantidade de COLATERAL a seizar (deixe 0 se usar repaidShares)
    /// @param repaidShares quantidade de SHARES da dívida a quitar (deixe 0 se usar seizedAssets)
    /// @param data callback opcional (pass empty bytes se não usar)
    /// @return assetsLiquidated quantia da dívida que foi efetivamente quitada
    /// @return seizedAssetsReturned quantia de colateral seizado (com bonus aplicado)
    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256 assetsLiquidated, uint256 seizedAssetsReturned);

    /// @notice Flashloan a 0% de fee do saldo do singleton (liquidez + colateral de todos os markets combinados).
    /// @dev O singleton transfere `assets` do `token` pro caller, invoca `onMorphoFlashLoan(assets, data)`
    ///      no caller, e ao retornar puxa de volta EXATAMENTE `assets` via transferFrom (sem premium).
    ///      O caller DEVE ter aprovado o singleton pra `assets` ao fim do callback.
    /// @param token endereço do ERC20 a emprestar
    /// @param assets quantidade (wei). Máx = saldo do token no singleton.
    /// @param data payload arbitrário repassado pro callback onMorphoFlashLoan
    function flashLoan(address token, uint256 assets, bytes calldata data) external;

    /// @notice Lê position de um borrower em um market
    /// @param id market id (hash do MarketParams)
    /// @param user borrower address
    function position(bytes32 id, address user) external view returns (Position memory);

    /// @notice Lê estado agregado de um market
    function market(bytes32 id) external view returns (Market memory);

    /// @notice Lê params de um market dado seu id
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
}

/// @title IMorphoFlashLoanCallback — callback que o tomador do flashloan Morpho deve implementar.
/// @dev Invocado pelo singleton DENTRO de `flashLoan`. Note que o callback NÃO recebe o endereço
///      do token — o tomador deve re-derivá-lo do `data` que ele mesmo encodou.
interface IMorphoFlashLoanCallback {
    /// @param assets quantidade emprestada (= a quantia a repagar, fee 0%)
    /// @param data payload que o tomador passou pra `flashLoan`
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
