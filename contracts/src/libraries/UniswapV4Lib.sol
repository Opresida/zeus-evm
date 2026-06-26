// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SwapStep} from "../interfaces/IZeusExecutor.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Permit2 (canônico) — o Universal Router puxa o token de entrada via Permit2.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title UniswapV4Lib — swap exact-input single via Universal Router (Uniswap V4 PoolManager).
/// @notice V4 é um singleton (PoolManager). O Universal Router resolve o `unlock` internamente, então
///         NÃO precisamos de callback no contrato (encaixa no padrão lib). Fluxo: aprova Permit2 → o UR
///         puxa o input (SETTLE com payerIsUser) → swap → TAKE da saída pra nós.
/// @dev `step.router` = Universal Router. `step.extraData` = abi.encode(PoolKey). Direção derivada de
///      tokenIn == currency0. amountIn=0 → usa o saldo (input que o reactor/flash entregou).
library UniswapV4Lib {
    using SafeERC20 for IERC20;

    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // Universal Router command
    uint8 internal constant CMD_V4_SWAP = 0x10;
    // V4 Router actions (v4-periphery Actions.sol)
    uint8 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACTION_SETTLE = 0x0b;
    uint8 internal constant ACTION_TAKE_ALL = 0x0f;
    // amount sentinel: settle a totalidade do delta aberto
    uint256 internal constant OPEN_DELTA = 0;

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    function swap(SwapStep memory step) internal returns (uint256 amountOut) {
        uint256 amountIn =
            step.amountIn == 0 ? IERC20(step.tokenIn).balanceOf(address(this)) : step.amountIn;

        PoolKey memory key = abi.decode(step.extraData, (PoolKey));
        bool zeroForOne = step.tokenIn == key.currency0;

        // Permit2: o token aprova o Permit2; o Permit2 autoriza o Universal Router a puxar `amountIn`.
        IERC20(step.tokenIn).forceApprove(PERMIT2, amountIn);
        IPermit2(PERMIT2).approve(step.tokenIn, step.router, uint160(amountIn), uint48(block.timestamp + 60));

        // V4_SWAP: actions = SWAP_EXACT_IN_SINGLE + SETTLE(payerIsUser) + TAKE_ALL.
        bytes memory actions =
            abi.encodePacked(ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE, ACTION_TAKE_ALL);

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(step.minAmountOut),
                hookData: ""
            })
        );
        // SETTLE(currency, amount=OPEN_DELTA, payerIsUser=true) → o UR puxa o input de nós via Permit2.
        params[1] = abi.encode(step.tokenIn, OPEN_DELTA, true);
        // TAKE_ALL(currency, minAmount) → recebe a saída pra nós (msgSender do UR = este contrato).
        params[2] = abi.encode(step.tokenOut, step.minAmountOut);

        bytes memory commands = abi.encodePacked(CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        uint256 balBefore = IERC20(step.tokenOut).balanceOf(address(this));
        IUniversalRouter(step.router).execute(commands, inputs, block.timestamp + 60);
        amountOut = IERC20(step.tokenOut).balanceOf(address(this)) - balBefore;
    }
}
