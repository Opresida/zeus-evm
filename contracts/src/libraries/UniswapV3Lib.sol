// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SwapStep} from "../interfaces/IZeusExecutor.sol";

/// @notice Interface mínima do Uniswap V3 SwapRouter02
/// @dev IMPORTANTE: SwapRouter02 (deployments modernos como Base) NÃO tem campo `deadline`
///      na struct — usa multicall com deadline externo se necessário.
///      Não confundir com SwapRouter V1 (que tem deadline). Selector é diferente.
interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title UniswapV3Lib — adapter inline pra swaps em Uniswap V3 (SwapRouter02)
/// @notice Decodifica fee tier de `extraData` e executa swap exact-input-single
/// @dev Funciona em qualquer EVM chain que tenha Uniswap V3 SwapRouter02 deployment.
///      Base mainnet:  0x2626664c2603336E57B271c5C0b26F421741e481
///      Arbitrum One:  0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
///      Optimism:      0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
///      Ethereum L1:   0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
library UniswapV3Lib {
    using SafeERC20 for IERC20;

    /// @notice Executa um swap usando UniswapV3 SwapRouter02
    /// @param step SwapStep com extraData = abi.encode(uint24 fee)
    /// @return amountOut quantidade de tokenOut recebida
    function swap(SwapStep memory step) internal returns (uint256 amountOut) {
        // amountIn = 0 → usa saldo atual do contrato
        uint256 actualAmountIn = step.amountIn == 0
            ? IERC20(step.tokenIn).balanceOf(address(this))
            : step.amountIn;

        // Decodifica fee tier (100, 500, 3000, 10000 — bps × 100)
        uint24 fee = abi.decode(step.extraData, (uint24));

        // Approve router (forceApprove lida com tokens não-padrão tipo USDT)
        IERC20(step.tokenIn).forceApprove(step.router, actualAmountIn);

        IUniswapV3SwapRouter.ExactInputSingleParams memory params = IUniswapV3SwapRouter.ExactInputSingleParams({
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            fee: fee,
            recipient: address(this),
            amountIn: actualAmountIn,
            amountOutMinimum: step.minAmountOut,
            sqrtPriceLimitX96: 0  // sem limite de preço
        });

        amountOut = IUniswapV3SwapRouter(step.router).exactInputSingle(params);
    }
}
