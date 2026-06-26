// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SwapStep} from "./IZeusExecutor.sol";
import {SignedOrder} from "./uniswapx/IReactor.sol";

/// @notice Parâmetros de um fill UniswapX (modo dex-sourced, atômico, SEM capital/flashloan).
/// @dev O reactor entrega o token de ENTRADA no callback; a gente faz o swap (swapSteps) pra produzir os
///      tokens de SAÍDA da ordem + o surplus; o reactor puxa as saídas; ficamos com o surplus (lucro).
///      `swapSteps` é OBRIGATÓRIO (sem modo inventário — não seguramos estoque). Lucro medido em `profitToken`.
struct UniswapXFillParams {
    address reactor; // reactor UniswapX (DEVE estar na whitelist default-deny)
    SignedOrder order; // a ordem assinada (bytes da ordem + assinatura EIP-712 do swapper)
    SwapStep[] swapSteps; // OBRIGATÓRIO: entrada → saídas (+ surplus). Vazio = revert
    address profitToken; // token onde medimos/ficamos com o surplus (ex: USDC/WETH)
    uint256 minProfitWei; // lucro mínimo em profitToken ou a tx reverte
    address profitReceiver; // pra onde mandar o surplus
}

/// @title IZeusUniswapXFiller — filler UniswapX (contrato satélite, EIP-170-safe; padrão da família v8).
interface IZeusUniswapXFiller {
    // ════════ EVENTS ════════

    event UniswapXFillExecuted(
        address indexed initiator, address indexed reactor, address indexed profitToken, uint256 profit
    );

    event Killed();
    event Revived();
    event OperatorSet(address indexed operator, bool allowed);
    event ApprovedReactorSet(address indexed reactor, bool allowed);
    event MaxTradeWeiUpdated(uint256 oldValue, uint256 newValue);
    event MaxTradePerTokenUpdated(address indexed token, uint256 oldValue, uint256 newValue);
    event TokenRescued(address indexed token, uint256 amount, address indexed to);

    // ════════ CUSTOM ERRORS ════════

    error NotAuthorized();
    error BotKilled();
    error InvalidCaller();
    error InsufficientProfit(uint256 actual, uint256 required);
    error InvalidDexType(uint8 dexType);
    error TradeTooLarge(uint256 amount, uint256 max);
    error EmptySwapSteps();
    /// @notice O reactor não está na whitelist (default-deny).
    error NotApprovedReactor(address reactor);
    /// @notice Output em ETH nativo — não suportado no v1 (off-chain só mira saídas ERC20).
    error NativeOutputUnsupported();

    // ════════ ENTRYPOINT ════════

    /// @notice Preenche uma ordem UniswapX: chama `executeWithCallback` no reactor (whitelisted), que entrega
    ///         o input e dispara `reactorCallback` (onde fazemos o swap e aprovamos as saídas). Atômico:
    ///         reverte tudo se o lucro líquido em `profitToken` < `minProfitWei`.
    function executeFill(UniswapXFillParams calldata params) external;

    // ════════ ADMIN (owner only) ════════

    function kill() external;
    function revive() external;
    function isKilled() external view returns (bool);

    function setOperator(address operator, bool allowed) external;
    function isOperator(address account) external view returns (bool);

    /// @notice Whitelist (default-deny) de reactors UniswapX que podem chamar nosso callback.
    function setApprovedReactor(address reactor, bool allowed) external;
    function isApprovedReactor(address reactor) external view returns (bool);

    function setMaxTradeWei(uint256 newMax) external;
    function maxTradeWei() external view returns (uint256);
    function setMaxTradePerToken(address token, uint256 newMax) external;
    function getMaxTradeFor(address token) external view returns (uint256);

    function rescueToken(address token, uint256 amount, address to) external;
}
