// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SwapStep} from "../interfaces/IZeusExecutor.sol";

/// @notice Interface mínima do PancakeSwap V3 SmartRouter / SwapRouter.
/// @dev DIFERENÇA CRÍTICA vs Uniswap V3 SwapRouter02: a struct `ExactInputSingleParams` do Pancake
///      INCLUI `uint256 deadline` (igual ao SwapRouter V1 da Uniswap). Roteá-lo pela struct sem
///      deadline (UniswapV3Lib) faz o decode bater errado e a chamada reverter. Por isso o Pancake
///      V3 tem DexType próprio (PancakeV3) e este adapter dedicado.
///      Fee tiers do Pancake V3 na Base: 100 / 500 / 2500 / 10000 (2500 no lugar de 3000).
interface IPancakeV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title PancakeV3Lib — adapter inline pra swaps no PancakeSwap V3 (struct com deadline)
/// @notice Decodifica fee tier de `extraData` e executa swap exact-input-single
/// @dev Base mainnet PancakeSwap V3 SwapRouter (verificar on-chain antes do Deploy):
///        0x1b81D678ffb9C0263b24A97847620C99d213eB14
library PancakeV3Lib {
    using SafeERC20 for IERC20;

    /// @notice Executa um swap usando PancakeSwap V3 SwapRouter (exactInputSingle COM deadline)
    /// @param step SwapStep com extraData = abi.encode(uint24 fee)
    /// @return amountOut quantidade de tokenOut recebida
    function swap(SwapStep memory step) internal returns (uint256 amountOut) {
        // amountIn = 0 → usa saldo atual do contrato (chain de swaps)
        uint256 actualAmountIn = step.amountIn == 0
            ? IERC20(step.tokenIn).balanceOf(address(this))
            : step.amountIn;

        // Decodifica fee tier (100, 500, 2500, 10000 no Pancake V3)
        uint24 fee = abi.decode(step.extraData, (uint24));

        // Approve router (forceApprove lida com tokens não-padrão tipo USDT)
        IERC20(step.tokenIn).forceApprove(step.router, actualAmountIn);

        IPancakeV3SwapRouter.ExactInputSingleParams memory params = IPancakeV3SwapRouter.ExactInputSingleParams({
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: actualAmountIn,
            amountOutMinimum: step.minAmountOut,
            sqrtPriceLimitX96: 0  // sem limite de preço
        });

        amountOut = IPancakeV3SwapRouter(step.router).exactInputSingle(params);
    }
}
