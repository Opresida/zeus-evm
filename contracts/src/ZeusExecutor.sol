// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/// @title ZeusExecutor — Atomic arbitrage executor on EVM chains
/// @notice Contrato hot-path que executa arb atomico:
///         (1) Modalidade Capital Proprio: bot envia tokens, executor faz multi-swap, devolve lucro
///         (2) Modalidade Flashloan: borrow → multi-swap → repay tudo em 1 tx
/// @dev STATUS: STUB — implementacao real depende de:
///      - OpenZeppelin (Ownable, ReentrancyGuard) instalados
///      - Adapters de DEX (Uniswap V2/V3, Aerodrome, Curve, Balancer)
///      - Integracao Aave V3 flashloan callback
///      Ver TODO.md e CONTRACTS.md para o plano completo.

/// @dev Cada swap segue este formato — codificado off-chain pelo detector
struct SwapStep {
    address router;           // endereco do router/pool do DEX
    address tokenIn;
    address tokenOut;
    uint256 amountIn;         // 0 = usar saldo atual (chain de swaps)
    uint256 minAmountOut;
    uint8 dexType;            // 0=UniV2, 1=UniV3, 2=Aerodrome, 3=Curve, 4=Balancer
    bytes extraData;          // fee tier (UniV3), pool address (Curve), etc.
}

struct ArbitrageParams {
    SwapStep[] steps;
    uint256 minProfitWei;     // profit minimo pra tx nao reverter
    address profitToken;      // token em que o lucro deve estar no final
    address profitReceiver;   // pra onde enviar o lucro (geralmente owner)
}

interface IZeusExecutor {
    // ──────────────── EVENTS ────────────────

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

    event Killed();
    event Revived();

    // ──────────────── ERRORS ────────────────

    error NotAuthorized();
    error Killed_();
    error InsufficientProfit(uint256 actual, uint256 required);
    error SwapFailed(uint256 stepIndex);
    error InvalidDexType(uint8 dexType);
    error FlashloanRepayFailed();

    // ──────────────── FUNCTIONS ────────────────

    /// @notice Modalidade 1: arbitragem com capital proprio
    /// @dev Bot envia tokens previamente pro contrato (ou approve transferFrom)
    function executeArbitrage(ArbitrageParams calldata params) external;

    /// @notice Modalidade 2: arbitragem usando flashloan Aave V3
    /// @dev Inicia flashloan; Aave chama executeOperation neste contrato pra rodar arb
    function executeFlashloanArbitrage(
        address asset,
        uint256 amount,
        ArbitrageParams calldata params
    ) external;

    /// @notice Kill switch global — owner para o bot instantaneamente
    function kill() external;
    function revive() external;
    function isKilled() external view returns (bool);

    /// @notice Resgatar tokens presos no contrato (ex: dust apos arb)
    function rescueToken(address token, uint256 amount, address to) external;
}
