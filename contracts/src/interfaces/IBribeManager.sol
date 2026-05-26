// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/// @notice Configuração de bribe pra block.coinbase.transfer.
/// @dev Estrutura fica aqui pra evitar circular deps quando Liquidator e ArbExecutor
///      ambos importam. BribeConfig é fonte única de verdade pra os 2 consumidores.
struct BribeConfig {
    uint256 bribeBps;
    uint256 minBribeWei;
    uint256 bribeMaxBps;
    uint24 swapFeeTier;
    uint256 swapSlippageBps;
}

/// @title IBribeManager — interface do contrato standalone que processa bribes.
/// @notice Resolve EIP-170 size limit (mantém ZeusLiquidator e ZeusArbExecutor sob 24576 bytes).
///         Compartilhado por AMBOS contratos consumidores via address imutável no constructor.
///
/// @dev Princípios:
///   - 1 BribeManager deployado, 2 consumidores (Liquidator + ArbExecutor)
///   - Estado próprio mínimo (sem state vars de bribe — receives weth/swapRouter como params)
///   - Recebe profitToken via `transferFrom` (caller approva BRIBE_MANAGER antes da call)
///   - Executa swap inline + unwrap + `block.coinbase.transfer` no contexto DELE
///   - Compatible com Flashbots/Atlas/Blocknative (que aceitam qualquer contrato pagar bribe)
interface IBribeManager {
    enum BribeOpType {
        LiquidationWithBribe,           // 0
        CompoundLiquidationWithBribe,   // 1
        MorphoLiquidationWithBribe,     // 2
        FlashloanBackrun                // 3
    }

    event BribePaid(
        address indexed initiator,
        BribeOpType indexed opType,
        address indexed coinbase,
        uint256 bribeNativeWei,
        uint256 grossProfit,
        uint256 netProfit
    );

    error InvalidBribeConfig();
    error BribeExceedsProfit(uint256 bribeNativeRequested, uint256 profitNativeAvailable);
    error BribeSwapFailed();
    error WethNotConfigured();
    error SwapRouterNotConfigured();
    error NotAuthorizedCaller();

    /// @notice Valida BribeConfig. Aceita (0, 0) como no-op.
    function validateConfig(BribeConfig calldata bribe) external pure;

    /// @notice Paga bribe ao block.coinbase. Caller deve approvar `profitToken` ao BribeManager
    ///         antes de chamar (transferFrom pulls bribeProfitTarget).
    ///         Em path WETH-fast, BribeManager faz transferFrom + withdraw + transfer.
    ///         Em path swap-inline, BribeManager faz transferFrom + swap UniV3 + withdraw + transfer.
    ///
    /// @return bribeNativeWei Quanto WETH (em wei) foi transferido pro coinbase
    /// @return profitTokenConsumed Quanto profitToken foi puxado do caller
    function pay(
        address profitToken,
        uint256 grossProfit,
        BribeConfig calldata bribe,
        address weth,
        address swapRouter,
        BribeOpType opType,
        address operator
    ) external returns (uint256 bribeNativeWei, uint256 profitTokenConsumed);
}
