// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SwapStep} from "../interfaces/IZeusExecutor.sol";

/// @notice Interface mínima do Aerodrome Router (Velodrome fork)
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;       // true = pool stable (ve(3,3) curve), false = pool volatile (x*y=k)
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function defaultFactory() external view returns (address);
}

/// @title AerodromeLib — adapter inline pra swaps no Aerodrome
/// @notice Decodifica flag `stable` de `extraData` e executa swap
/// @dev Aerodrome Router Base: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
library AerodromeLib {
    using SafeERC20 for IERC20;

    /// @notice Executa um swap usando Aerodrome Router
    /// @param step SwapStep com extraData = abi.encode(bool isStable, address factory)
    ///             se factory = address(0), usa defaultFactory() do router
    /// @return amountOut quantidade de tokenOut recebida
    function swap(SwapStep memory step) internal returns (uint256 amountOut) {
        uint256 actualAmountIn = step.amountIn == 0
            ? IERC20(step.tokenIn).balanceOf(address(this))
            : step.amountIn;

        (bool isStable, address factoryParam) = abi.decode(step.extraData, (bool, address));
        address factory = factoryParam == address(0)
            ? IAerodromeRouter(step.router).defaultFactory()
            : factoryParam;

        IERC20(step.tokenIn).forceApprove(step.router, actualAmountIn);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: step.tokenIn,
            to: step.tokenOut,
            stable: isStable,
            factory: factory
        });

        uint256[] memory amounts = IAerodromeRouter(step.router).swapExactTokensForTokens(
            actualAmountIn,
            step.minAmountOut,
            routes,
            address(this),
            block.timestamp
        );

        amountOut = amounts[amounts.length - 1];
    }
}
