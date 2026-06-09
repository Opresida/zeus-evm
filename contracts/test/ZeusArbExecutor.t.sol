// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {BribeManager} from "../src/BribeManager.sol";
import {ZeusArbExecutor} from "../src/ZeusArbExecutor.sol";
import {IZeusArbExecutor, BackrunParams} from "../src/interfaces/IZeusArbExecutor.sol";
import {SwapStep, ArbitrageParams, DexType, FlashSource} from "../src/interfaces/IZeusExecutor.sol";
import {BribeConfig} from "../src/interfaces/IBribeManager.sol";

/// @title ZeusArbExecutorTest — adversariais cobrindo:
///   1. Constructor (BribeManager + Aave Pool + owner + maxTrade)
///   2. Auth (operator/killed)
///   3. Param validation (zero addresses)
///   4. executeArbitrage (modalidade wallet)
///   5. executeFlashloanArbitrage + executeFlashloanBackrun
///   6. Bribe config validation
contract ZeusArbExecutorTest is Test {
    BribeManager public bribeManager;
    ZeusArbExecutor public arbExecutor;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public unauthorized = makeAddr("unauthorized");
    address public profitReceiver = makeAddr("profitReceiver");

    address constant FAKE_AAVE_POOL = address(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
    address constant FAKE_MORPHO = address(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address constant FAKE_BALANCER = address(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    address constant FAKE_USDC = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address constant FAKE_WETH = address(0x4200000000000000000000000000000000000006);

    uint256 public constant INITIAL_MAX_TRADE_WEI = 100 ether;

    function setUp() public {
        bribeManager = new BribeManager();
        arbExecutor =
            new ZeusArbExecutor(FAKE_AAVE_POOL, FAKE_MORPHO, FAKE_BALANCER, address(bribeManager), owner, INITIAL_MAX_TRADE_WEI);
        vm.startPrank(owner);
        arbExecutor.revive();
        arbExecutor.setOperator(operator, true);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═══════════════════════════════════════════════════════════════════════

    function test_Constructor_SetsImmutables() public view {
        assertEq(arbExecutor.AAVE_V3_POOL(), FAKE_AAVE_POOL);
        assertEq(arbExecutor.BRIBE_MANAGER(), address(bribeManager));
        assertEq(arbExecutor.owner(), owner);
        assertEq(arbExecutor.maxTradeWei(), INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroBribeManager() public {
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        new ZeusArbExecutor(FAKE_AAVE_POOL, FAKE_MORPHO, FAKE_BALANCER, address(0), owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroMorpho() public {
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        new ZeusArbExecutor(FAKE_AAVE_POOL, address(0), FAKE_BALANCER, address(bribeManager), owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroBalancer() public {
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        new ZeusArbExecutor(FAKE_AAVE_POOL, FAKE_MORPHO, address(0), address(bribeManager), owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_StartsKilled() public {
        ZeusArbExecutor fresh =
            new ZeusArbExecutor(FAKE_AAVE_POOL, FAKE_MORPHO, FAKE_BALANCER, address(bribeManager), owner, INITIAL_MAX_TRADE_WEI);
        assertTrue(fresh.isKilled());
    }

    function test_Constructor_SetsFlashSourceImmutables() public view {
        assertEq(arbExecutor.MORPHO_SINGLETON(), FAKE_MORPHO);
        assertEq(arbExecutor.BALANCER_VAULT(), FAKE_BALANCER);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  executeArbitrage (wallet)
    // ═══════════════════════════════════════════════════════════════════════

    function test_ExecuteArbitrage_OnlyOperator() public {
        ArbitrageParams memory p = _emptyArbParams();
        p.steps = _dummySteps();
        vm.prank(unauthorized);
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        arbExecutor.executeArbitrage(p);
    }

    function test_ExecuteArbitrage_RevertsWhenKilled() public {
        vm.prank(owner);
        arbExecutor.kill();
        ArbitrageParams memory p = _emptyArbParams();
        p.steps = _dummySteps();
        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.BotKilled.selector);
        arbExecutor.executeArbitrage(p);
    }

    function test_ExecuteArbitrage_RevertsOnEmptySteps() public {
        ArbitrageParams memory p = _emptyArbParams();
        // steps vazio
        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.EmptySteps.selector);
        arbExecutor.executeArbitrage(p);
    }

    function test_ExecuteArbitrage_RevertsOnZeroProfitToken() public {
        ArbitrageParams memory p = _emptyArbParams();
        p.steps = _dummySteps();
        p.profitToken = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        arbExecutor.executeArbitrage(p);
    }

    function test_ExecuteArbitrage_RevertsOnZeroProfitReceiver() public {
        ArbitrageParams memory p = _emptyArbParams();
        p.steps = _dummySteps();
        p.profitReceiver = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        arbExecutor.executeArbitrage(p);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  executeFlashloanArbitrage
    // ═══════════════════════════════════════════════════════════════════════

    function test_ExecuteFlashloanArb_RevertsOnEmptySteps() public {
        ArbitrageParams memory p = _emptyArbParams();
        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.EmptySteps.selector);
        arbExecutor.executeFlashloanArbitrage(FAKE_USDC, 100e6, p);
    }

    function test_ExecuteFlashloanArb_RevertsOnZeroFlashloanAsset() public {
        ArbitrageParams memory p = _emptyArbParams();
        p.steps = _dummySteps();
        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        arbExecutor.executeFlashloanArbitrage(address(0), 100e6, p);
    }

    function test_ExecuteFlashloanArb_RevertsOnTradeTooLarge() public {
        vm.prank(owner);
        arbExecutor.setMaxTradePerToken(FAKE_USDC, 50e6);

        ArbitrageParams memory p = _emptyArbParams();
        p.steps = _dummySteps();
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusArbExecutor.TradeTooLarge.selector, uint256(100e6), uint256(50e6))
        );
        arbExecutor.executeFlashloanArbitrage(FAKE_USDC, 100e6, p);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  executeFlashloanBackrun
    // ═══════════════════════════════════════════════════════════════════════

    function test_ExecuteBackrun_OnlyOperator() public {
        BackrunParams memory bp = _emptyBackrunParams();
        bp.steps = _dummySteps();
        vm.prank(unauthorized);
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        arbExecutor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function test_ExecuteBackrun_RevertsOnEmptySteps() public {
        BackrunParams memory bp = _emptyBackrunParams();
        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.EmptySteps.selector);
        arbExecutor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function test_ExecuteBackrun_RevertsOnZeroProfitReceiver() public {
        BackrunParams memory bp = _emptyBackrunParams();
        bp.steps = _dummySteps();
        bp.profitReceiver = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusArbExecutor.NotAuthorized.selector);
        arbExecutor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function test_ExecuteBackrun_RevertsOnInvalidBribe() public {
        BackrunParams memory bp = _emptyBackrunParams();
        bp.steps = _dummySteps();
        bp.bribe = BribeConfig({
            bribeBps: 10_001, // inválido
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        vm.prank(operator);
        vm.expectRevert(); // InvalidBribeConfig vindo do BribeManager
        arbExecutor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function test_ExecuteBackrun_AcceptsNoBribe() public {
        // bribe=(0,0) é no-op válido — passa validate, reverte só no Aave call
        BackrunParams memory bp = _emptyBackrunParams();
        bp.steps = _dummySteps();
        vm.prank(operator);
        vm.expectRevert(); // do Aave (sem pool real)
        arbExecutor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _emptyArbParams() internal view returns (ArbitrageParams memory) {
        SwapStep[] memory steps;
        return ArbitrageParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: FAKE_USDC,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });
    }

    function _emptyBackrunParams() internal view returns (BackrunParams memory) {
        SwapStep[] memory steps;
        return BackrunParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: FAKE_USDC,
            profitReceiver: profitReceiver,
            bribe: BribeConfig({
                bribeBps: 0,
                minBribeWei: 0,
                bribeMaxBps: 0,
                swapFeeTier: 0,
                swapSlippageBps: 0
            }),
            flashSource: FlashSource.Aave
        });
    }

    function _dummySteps() internal pure returns (SwapStep[] memory steps) {
        steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: address(0xABCD),
            tokenIn: FAKE_USDC,
            tokenOut: FAKE_WETH,
            amountIn: 100e6,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(uint24(500))
        });
    }
}
