// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UniswapV4Lib} from "../../src/libraries/UniswapV4Lib.sol";
import {SwapStep, DexType} from "../../src/interfaces/IZeusExecutor.sol";

/// @dev Harness que expõe a lib internal pra teste isolado.
contract V4SwapHarness {
    function doSwap(SwapStep memory step) external returns (uint256) {
        return UniswapV4Lib.swap(step);
    }

    receive() external payable {}
}

/// @title UniswapV4Lib fork test — swap WETH→USDC REAL via Universal Router (V4) na Base.
/// @notice A prova de fogo da execução V4: se o encoding do comando V4_SWAP (actions/settle/take) +
///         o fluxo Permit2 estiverem certos, o swap entrega USDC; senão reverte (atômico).
contract UniswapV4LibForkTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;

    // Pool V4 WETH/USDC confirmado on-chain (fee=500, tickSpacing=10, hooks=0). currency0=WETH (0x42<0x83).
    uint24 constant FEE = 500;
    int24 constant TICK_SPACING = 10;

    uint256 constant FORK_BLOCK = 47_858_090;

    V4SwapHarness harness;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_HTTP", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        harness = new V4SwapHarness();
    }

    function _step(uint256 amountIn) internal pure returns (SwapStep memory step) {
        UniswapV4Lib.PoolKey memory key = UniswapV4Lib.PoolKey({
            currency0: WETH,
            currency1: USDC,
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: address(0)
        });
        step = SwapStep({
            router: UNIVERSAL_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: amountIn,
            minAmountOut: 0,
            dexType: DexType.UniswapV4,
            extraData: abi.encode(key)
        });
    }

    function test_Fork_V4_SwapWethToUsdc() public {
        uint256 amountIn = 1 ether;
        deal(WETH, address(harness), amountIn);

        uint256 before = IERC20(USDC).balanceOf(address(harness));
        uint256 out = harness.doSwap(_step(0)); // amountIn=0 → usa o saldo
        uint256 received = IERC20(USDC).balanceOf(address(harness)) - before;

        emit log_named_decimal_uint("USDC recebido via V4", received, 6);
        assertGt(received, 0, "deve receber USDC do swap V4");
        assertEq(received, out, "retorno da lib == saldo recebido");
        // ~1568 USDC por 1 WETH nesse bloco (sanity: > 1000, < 3000)
        assertGt(received, 1_000e6, "saida V4 plausivel (> 1000 USDC)");
        assertEq(IERC20(WETH).balanceOf(address(harness)), 0, "consumiu todo o WETH");
    }
}
