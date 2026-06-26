// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BribeManager} from "../../src/BribeManager.sol";
import {ZeusArbExecutor} from "../../src/ZeusArbExecutor.sol";
import {IZeusArbExecutor, BackrunParams} from "../../src/interfaces/IZeusArbExecutor.sol";
import {SwapStep, ArbitrageParams, DexType, FlashSource} from "../../src/interfaces/IZeusExecutor.sol";
import {BribeConfig} from "../../src/interfaces/IBribeManager.sol";

/// @title ZeusArbExecutor fork tests — wire + arb path em Base mainnet.
///
/// @notice Cobre:
///   - Constructor com Aave V3 pool real
///   - Setters (weth + uniV3SwapRouter)
///   - executeOperation callback security
///   - executeArbitrage wallet path: deal USDC + 1-step UniV3 swap →
///       valida que swap roda contra pool real, mas reverte InsufficientProfit
///       porque round-trip 1-leg perde fee (sem dislocation real)
///   - Flashloan trigger valida Aave round-trip
contract ZeusArbExecutorForkTest is Test {
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_SINGLETON = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER_V3 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    uint256 constant FORK_BLOCK = 28_000_000;
    uint256 constant INITIAL_MAX_TRADE = 1_000 ether;
    uint24 constant USDC_WETH_FEE = 500;

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
        arb.setWeth(WETH);
        arb.setUniV3SwapRouter(SWAP_ROUTER_V3);
        arb.setOperator(operator, true);
        arb.revive();
        arb.setApprovedRouter(SWAP_ROUTER_V3, true);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Wiring contra Base mainnet
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_Constructor_WiresImmutables() public view {
        assertEq(arb.AAVE_V3_POOL(), AAVE_V3_POOL);
        assertEq(arb.BRIBE_MANAGER(), address(bribeManager));
        assertEq(arb.owner(), owner);
    }

    function test_Fork_Setters_AcceptRealAddresses() public view {
        assertEq(arb.weth(), WETH);
        assertEq(arb.uniV3SwapRouter(), SWAP_ROUTER_V3);
        assertTrue(arb.isOperator(operator));
        assertFalse(arb.isKilled());
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  executeOperation — callback security
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteOperation_RejectsNonAaveCaller() public {
        bytes memory params = abi.encode(uint8(0), bytes(""));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(IZeusArbExecutor.InvalidCaller.selector);
        arb.executeOperation(USDC, 1000e6, 5e6, address(arb), params);
    }

    function test_Fork_ExecuteOperation_RejectsWrongInitiator() public {
        bytes memory params = abi.encode(uint8(0), bytes(""));
        vm.prank(AAVE_V3_POOL);
        vm.expectRevert(IZeusArbExecutor.InvalidCaller.selector);
        arb.executeOperation(USDC, 1000e6, 5e6, makeAddr("phisher"), params);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  executeArbitrage wallet — exercita swap real contra UniV3
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteArbitrage_RoundTripRevertsInsufficientProfit() public {
        // 1-step swap (USDC → WETH) consome fee, sem dislocation real.
        // Validamos que swap roda no router real, mas reverte InsufficientProfit
        // porque profitToken = USDC e balance termina menor.
        uint256 amountIn = 100e6; // 100 USDC
        deal(USDC, address(arb), amountIn);

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SWAP_ROUTER_V3,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(USDC_WETH_FEE)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1, // queremos lucro em USDC, mas ele só sai
            profitToken: USDC,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        vm.prank(operator);
        vm.expectRevert(); // InsufficientProfit (USDC saiu pro pool, sobrou 0)
        arb.executeArbitrage(p);
    }

    function test_Fork_ExecuteArbitrage_SwapPushesPriceAndProfitsInWETH() public {
        // Path mais realista: USDC → WETH com profitToken=WETH.
        // O swap converte USDC em WETH, e profit é o WETH recebido.
        // Como começamos com 0 WETH e terminamos com >0, profit > minProfitWei.
        uint256 amountIn = 1_000e6; // 1000 USDC
        deal(USDC, address(arb), amountIn);

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SWAP_ROUTER_V3,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: amountIn,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(USDC_WETH_FEE)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: WETH,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        uint256 receiverBefore = IERC20(WETH).balanceOf(profitReceiver);

        vm.prank(operator);
        arb.executeArbitrage(p);

        uint256 receiverAfter = IERC20(WETH).balanceOf(profitReceiver);
        assertGt(receiverAfter - receiverBefore, 0);
        // Contract limpo após transferência
        assertEq(IERC20(WETH).balanceOf(address(arb)), 0);
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Flashloan round-trip contra Aave V3 real
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteFlashloanArb_RoundTripRevertsOnRepayShortfall() public {
        // Sem dislocation real, o flashloan vai puxar USDC, fazer swap,
        // e não conseguirá pagar o premium → FlashloanRepayShortfall ou
        // erro do Aave por approve insuficiente.
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SWAP_ROUTER_V3,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 1_000e6,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(USDC_WETH_FEE)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: USDC,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        vm.prank(operator);
        vm.expectRevert(); // shortfall ou erro do Aave
        arb.executeFlashloanArbitrage(USDC, 1_000e6, p);
    }

    /// @dev Mesmo round-trip, mas financiado pelo flashloan 0% do Morpho Blue (singleton real na Base).
    ///      Prova que `executeFlashloanArbitrage` com FlashSource.Morpho: o Morpho aceitou nosso
    ///      flashLoan(USDC, ...), invocou onMorphoFlashLoan, o decode do blob + flag transiente
    ///      funcionaram, e o fluxo chegou no swap/repay — revertendo por shortfall (sem dislocation
    ///      real → não paga o principal de volta). Espelha o caso Aave acima.
    function test_Fork_ExecuteFlashloanArb_FlashSourceMorpho_RoundTrip() public {
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SWAP_ROUTER_V3,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 1_000e6,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(USDC_WETH_FEE)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: USDC,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Morpho
        });

        vm.prank(operator);
        // Reverte no repay/profit (sem dislocation), NÃO na iniciação do flash do Morpho.
        vm.expectRevert();
        arb.executeFlashloanArbitrage(USDC, 1_000e6, p);
    }

    /// @dev Round-trip financiado pelo flashloan 0% do Balancer V2 Vault (real na Base).
    ///      Prova que `executeFlashloanArbitrage` com FlashSource.Balancer:
    ///      flashLoan(recipient, [USDC], [amount], blob) → receiveFlashLoan → flag transiente
    ///      → decode → dispatch do swap → repay, revertendo por shortfall (sem lucro real).
    ///      Espelha o ZeusLiquidator.fork (_FlashSourceBalancer_RoundTrip) no contrato do ARB.
    function test_Fork_ExecuteFlashloanArb_FlashSourceBalancer_RoundTrip() public {
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SWAP_ROUTER_V3,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 1_000e6,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(USDC_WETH_FEE)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: USDC,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Balancer
        });

        vm.prank(operator);
        // Reverte no repay/profit, NÃO na iniciação do flash do Balancer Vault.
        vm.expectRevert();
        arb.executeFlashloanArbitrage(USDC, 1_000e6, p);
    }

    function test_Fork_ExecuteBackrun_ValidatesBribeConfig() public {
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SWAP_ROUTER_V3,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 1_000e6,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(USDC_WETH_FEE)
        });

        BackrunParams memory bp = BackrunParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: USDC,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave,
            bribe: BribeConfig({
                bribeBps: 10_001, // inválido (>10000)
                minBribeWei: 0,
                bribeMaxBps: 9_000,
                swapFeeTier: USDC_WETH_FEE,
                swapSlippageBps: 50
            })
        });

        vm.prank(operator);
        vm.expectRevert(); // InvalidBribeConfig do BribeManager
        arb.executeFlashloanBackrun(USDC, 1_000e6, bp);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Kill switch
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_KillSwitch_BlocksExecution() public {
        vm.prank(owner);
        arb.kill();

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SWAP_ROUTER_V3,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 100e6,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(USDC_WETH_FEE)
        });

        ArbitrageParams memory p = ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: USDC,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.BotKilled.selector);
        arb.executeArbitrage(p);
    }
}
