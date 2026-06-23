// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BribeManager} from "../../src/BribeManager.sol";
import {ZeusArbExecutor} from "../../src/ZeusArbExecutor.sol";
import {SwapStep, ArbitrageParams, DexType, FlashSource} from "../../src/interfaces/IZeusExecutor.sol";

/// @title Fork tests dos novos adapters de DEX (Motor 2 — onda 1).
///
/// @notice Valida que `_executeSwaps` roteia corretamente os DexType novos contra os routers
///         REAIS na Base, exercitando UniswapV2Lib (BaseSwap) e SlipstreamLib (Aerodrome CL).
///         Estes testes DOBRAM como verificação on-chain dos endereços de `chain-config/base.ts`:
///         se um router/factory/tickSpacing estiver errado, o swap reverte e o teste FALHA no CI
///         (BASE_RPC_HTTP setado). Sem RPC, dão skip (igual aos outros fork tests).
///
/// @dev Padrão: deal USDC → swap USDC→WETH via o DexType sob teste com profitToken=WETH →
///      profit = WETH recebido (>0). Espelha test_Fork_ExecuteArbitrage_SwapPushesPriceAndProfitsInWETH.
contract ZeusArbExecutorDexForkTest is Test {
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_SINGLETON = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // ── Endereços sob verificação (devem bater com chain-config/base.ts) ──
    // BaseSwap (UniV2) — já estava no repo (verificado pelo time).
    address constant BASESWAP_ROUTER = 0x327Df1E6de05895d2ab08513aaDD9313Fe505d86;
    // Aerodrome Slipstream SwapRouter.
    address constant SLIPSTREAM_SWAP_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    // tickSpacing do pool WETH/USDC no Slipstream (volatile). Ajustar se o CI revelar outro.
    int24 constant SLIP_WETH_USDC_TICK_SPACING = 100;
    // PancakeSwap V3 SwapRouter (struct exactInputSingle COM deadline — DexType.PancakeV3).
    address constant PANCAKE_V3_SWAP_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    uint24 constant PANCAKE_WETH_USDC_FEE = 500; // ajustar se o CI revelar outro tier com liquidez
    // SushiSwap V3 SwapRouter na Base — tem `deadline` na struct (NÃO é SwapRouter02). Verificado
    // neste fork: reverte via DexType.UniswapV3, passa via DexType.PancakeV3. → routerStyle='pancakeV3'.
    address constant SUSHI_V3_SWAP_ROUTER = 0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f;
    uint24 constant SUSHI_WETH_USDC_FEE = 500; // ajustar se o CI revelar outro tier com liquidez

    uint256 constant FORK_BLOCK = 28_000_000;
    uint256 constant INITIAL_MAX_TRADE = 1_000 ether;

    BribeManager public bribeManager;
    ZeusArbExecutor public arb;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_HTTP", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        bribeManager = new BribeManager();
        arb = new ZeusArbExecutor(AAVE_V3_POOL, MORPHO_SINGLETON, BALANCER_VAULT, address(bribeManager), owner, INITIAL_MAX_TRADE);

        vm.startPrank(owner);
        arb.setOperator(operator, true);
        arb.revive();
        vm.stopPrank();
    }

    /// UniswapV2 (BaseSwap): swap USDC→WETH via DexType.UniswapV2 (extraData vazio).
    function test_Fork_UniswapV2_BaseSwap_SwapProfitsInWETH() public {
        uint256 amountIn = 1_000e6; // 1000 USDC
        deal(USDC, address(arb), amountIn);

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: BASESWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            minAmountOut: 0,
            dexType: DexType.UniswapV2,
            extraData: "" // UniV2 não usa extraData
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: WETH,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        uint256 before = IERC20(WETH).balanceOf(profitReceiver);
        vm.prank(operator);
        arb.executeArbitrage(p);

        assertGt(IERC20(WETH).balanceOf(profitReceiver) - before, 0, "BaseSwap swap nao rendeu WETH");
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "USDC sobrou no contrato");
    }

    /// Slipstream (Aerodrome CL): swap USDC→WETH via DexType.Slipstream (extraData = int24 tickSpacing).
    function test_Fork_Slipstream_SwapProfitsInWETH() public {
        uint256 amountIn = 1_000e6; // 1000 USDC
        deal(USDC, address(arb), amountIn);

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SLIPSTREAM_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            minAmountOut: 0,
            dexType: DexType.Slipstream,
            extraData: abi.encode(SLIP_WETH_USDC_TICK_SPACING)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: WETH,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        uint256 before = IERC20(WETH).balanceOf(profitReceiver);
        vm.prank(operator);
        arb.executeArbitrage(p);

        assertGt(IERC20(WETH).balanceOf(profitReceiver) - before, 0, "Slipstream swap nao rendeu WETH");
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "USDC sobrou no contrato");
    }

    /// PancakeV3: swap USDC→WETH via DexType.PancakeV3 (extraData = uint24 fee).
    /// Prova que a struct exactInputSingle COM deadline (PancakeV3Lib) não reverte no router real —
    /// é exatamente o caso que reverteria se Pancake fosse roteado pelo UniswapV3Lib (sem deadline).
    function test_Fork_PancakeV3_SwapProfitsInWETH() public {
        uint256 amountIn = 1_000e6; // 1000 USDC
        deal(USDC, address(arb), amountIn);

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: PANCAKE_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            minAmountOut: 0,
            dexType: DexType.PancakeV3,
            extraData: abi.encode(PANCAKE_WETH_USDC_FEE)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: WETH,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        uint256 before = IERC20(WETH).balanceOf(profitReceiver);
        vm.prank(operator);
        arb.executeArbitrage(p);

        assertGt(IERC20(WETH).balanceOf(profitReceiver) - before, 0, "PancakeV3 swap nao rendeu WETH");
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "USDC sobrou no contrato");
    }

    /// SushiV3: swap USDC→WETH via DexType.PancakeV3 (router da Sushi na Base TEM deadline).
    /// Achado do fork: rotear Sushi como UniswapV3 (sem deadline) REVERTE — por isso usa o adapter
    /// com deadline (PancakeV3Lib), igual ao Pancake. base.ts: sushiswap-v3 routerStyle='pancakeV3'.
    function test_Fork_SushiV3_SwapProfitsInWETH() public {
        uint256 amountIn = 1_000e6; // 1000 USDC
        deal(USDC, address(arb), amountIn);

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SUSHI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            minAmountOut: 0,
            dexType: DexType.PancakeV3,
            extraData: abi.encode(SUSHI_WETH_USDC_FEE)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: WETH,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        uint256 before = IERC20(WETH).balanceOf(profitReceiver);
        vm.prank(operator);
        arb.executeArbitrage(p);

        assertGt(IERC20(WETH).balanceOf(profitReceiver) - before, 0, "SushiV3 swap nao rendeu WETH");
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "USDC sobrou no contrato");
    }
}
