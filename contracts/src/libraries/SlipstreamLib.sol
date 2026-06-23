// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SwapStep} from "../interfaces/IZeusExecutor.sol";

/// @notice Interface mínima do Aerodrome Slipstream CL SwapRouter
/// @dev DIFERENÇAS vs Uniswap V3 SwapRouter02:
///        - usa `int24 tickSpacing` no lugar de `uint24 fee` (pools CL são por tickSpacing)
///        - a struct TEM campo `deadline` (igual ao SwapRouter V1 da Uniswap)
///      Slipstream é fork do Velodrome CL; mesma ABI no Aerodrome (Base).
interface ISlipstreamSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title SlipstreamLib — adapter inline pra swaps no Aerodrome Slipstream (concentrated liquidity)
/// @notice Decodifica tickSpacing de `extraData` e executa swap exact-input-single
/// @dev Base mainnet Slipstream SwapRouter (verificar on-chain antes do Deploy):
///        0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5
library SlipstreamLib {
    using SafeERC20 for IERC20;

    /// @notice Executa um swap usando Slipstream CL SwapRouter
    /// @param step SwapStep com extraData = abi.encode(int24 tickSpacing)
    /// @return amountOut quantidade de tokenOut recebida
    function swap(SwapStep memory step) internal returns (uint256 amountOut) {
        // amountIn = 0 → usa saldo atual do contrato
        uint256 actualAmountIn = step.amountIn == 0
            ? IERC20(step.tokenIn).balanceOf(address(this))
            : step.amountIn;

        // Decodifica tickSpacing (1, 50, 100, 200, 2000… — específico do pool CL)
        int24 tickSpacing = abi.decode(step.extraData, (int24));

        // Approve router (forceApprove lida com tokens não-padrão tipo USDT)
        IERC20(step.tokenIn).forceApprove(step.router, actualAmountIn);

        ISlipstreamSwapRouter.ExactInputSingleParams memory params = ISlipstreamSwapRouter.ExactInputSingleParams({
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            tickSpacing: tickSpacing,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: actualAmountIn,
            amountOutMinimum: step.minAmountOut,
            sqrtPriceLimitX96: 0  // sem limite de preço
        });

        amountOut = ISlipstreamSwapRouter(step.router).exactInputSingle(params);
    }
}
