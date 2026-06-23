// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SwapStep} from "../interfaces/IZeusExecutor.sol";

/// @notice Interface mínima do Uniswap V2 Router02 (e forks: BaseSwap, AlienBase, SwapBased…)
/// @dev Todos os forks UniV2 compartilham essa ABI canônica. O `router` por-step aponta pro
///      Router02 do venue; o factory fica off-chain (pricing). Path direto [tokenIn, tokenOut] —
///      cada SwapStep é 1 hop (triangular já vem decomposto em steps pelo off-chain).
interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /// @dev Variante fee-on-transfer: alguns tokens cobram taxa no transfer. Não usada por
    ///      default (a versão padrão é mais barata em gas e o off-chain filtra tokens FoT),
    ///      mas mantida documentada caso precise no futuro.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title UniswapV2Lib — adapter inline pra swaps em DEXes UniswapV2-compatíveis
/// @notice extraData é ignorado (UniV2 não tem fee tier nem tickSpacing). Path direto de 1 hop.
/// @dev Base mainnet routers (verificar on-chain antes de usar no Deploy):
///        BaseSwap  Router02: 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86
///        AlienBase Router02: 0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7
///        SwapBased Router02: 0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066
library UniswapV2Lib {
    using SafeERC20 for IERC20;

    /// @notice Executa um swap exact-input via Router02 UniV2-compatível
    /// @param step SwapStep — extraData ignorado; router = Router02 do venue
    /// @return amountOut quantidade de tokenOut recebida
    function swap(SwapStep memory step) internal returns (uint256 amountOut) {
        // amountIn = 0 → usa saldo atual do contrato (chain de swaps)
        uint256 actualAmountIn = step.amountIn == 0
            ? IERC20(step.tokenIn).balanceOf(address(this))
            : step.amountIn;

        // Approve router (forceApprove lida com tokens não-padrão tipo USDT)
        IERC20(step.tokenIn).forceApprove(step.router, actualAmountIn);

        address[] memory path = new address[](2);
        path[0] = step.tokenIn;
        path[1] = step.tokenOut;

        uint256[] memory amounts = IUniswapV2Router02(step.router).swapExactTokensForTokens(
            actualAmountIn,
            step.minAmountOut,
            path,
            address(this),
            block.timestamp
        );

        amountOut = amounts[amounts.length - 1];
    }
}
