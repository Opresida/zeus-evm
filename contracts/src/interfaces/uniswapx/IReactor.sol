// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/// @title Interfaces UniswapX (Reactor + Callback) — espelham `Uniswap/UniswapX` OrderStructs/IReactor.
/// @notice Usamos `address` no lugar de IReactor/ERC20/IValidationCallback (ABI-compatível p/ decode do callback).
///         Fluxo dex-sourced (sem capital): o reactor puxa o INPUT do swapper → entrega ao nosso contrato →
///         chama `reactorCallback` (fazemos o swap input→output) → puxa o OUTPUT de nós → entrega ao swapper.
///         Atômico: se faltar output, reverte (só gás). Mesmo modelo do nosso callback de pré-liquidação.

struct SignedOrder {
    bytes order;
    bytes sig;
}

struct OrderInfo {
    address reactor;
    address swapper;
    uint256 nonce;
    uint256 deadline;
    address additionalValidationContract;
    bytes additionalValidationData;
}

struct InputToken {
    address token;
    uint256 amount;
    uint256 maxAmount;
}

struct OutputToken {
    address token;
    uint256 amount;
    address recipient;
}

struct ResolvedOrder {
    OrderInfo info;
    InputToken input;
    OutputToken[] outputs;
    bytes sig;
    bytes32 hash;
}

interface IReactor {
    /// @notice Preenche uma ordem com callback (caminho dex-sourced: recebemos o input no callback).
    function executeWithCallback(SignedOrder calldata order, bytes calldata callbackData) external payable;
}

interface IReactorCallback {
    /// @notice Chamado pelo reactor durante o fill. Recebemos os inputs; devolvemos os outputs (via approve).
    function reactorCallback(ResolvedOrder[] memory resolvedOrders, bytes memory callbackData) external;
}
