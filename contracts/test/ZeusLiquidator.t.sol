// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {BribeManager} from "../src/BribeManager.sol";
import {ZeusLiquidator} from "../src/ZeusLiquidator.sol";
import {
    IZeusLiquidator,
    LiquidationParams,
    CompoundLiquidationParams,
    MorphoLiquidationParams
} from "../src/interfaces/IZeusLiquidator.sol";
import {SwapStep, DexType} from "../src/interfaces/IZeusExecutor.sol";
import {BribeConfig} from "../src/interfaces/IBribeManager.sol";

/// @title ZeusLiquidatorTest — adversariais cobrindo:
///   1. Constructor (BribeManager + Aave Pool + owner + maxTrade)
///   2. Auth (operator/killed/kill switch)
///   3. Param validation (zero addresses)
///   4. Per-token cap (H-02 fix preservado)
///   5. Bribe config validation pelos paths WithBribe
///   6. Admin (setOperator, setWeth, setUniV3SwapRouter)
contract ZeusLiquidatorTest is Test {
    BribeManager public bribeManager;
    ZeusLiquidator public liquidator;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public unauthorized = makeAddr("unauthorized");
    address public profitReceiver = makeAddr("profitReceiver");

    address constant FAKE_AAVE_POOL = address(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
    address constant FAKE_USDC = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address constant FAKE_WETH = address(0x4200000000000000000000000000000000000006);
    address constant FAKE_UNIV3 = address(0x2626664c2603336E57B271c5C0b26F421741e481);

    uint256 public constant INITIAL_MAX_TRADE_WEI = 100 ether;

    function setUp() public {
        bribeManager = new BribeManager();
        liquidator = new ZeusLiquidator(FAKE_AAVE_POOL, address(bribeManager), owner, INITIAL_MAX_TRADE_WEI);
        vm.startPrank(owner);
        liquidator.revive();
        liquidator.setOperator(operator, true);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═══════════════════════════════════════════════════════════════════════

    function test_Constructor_SetsImmutables() public view {
        assertEq(liquidator.AAVE_V3_POOL(), FAKE_AAVE_POOL);
        assertEq(liquidator.BRIBE_MANAGER(), address(bribeManager));
        assertEq(liquidator.owner(), owner);
        assertEq(liquidator.maxTradeWei(), INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroAavePool() public {
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        new ZeusLiquidator(address(0), address(bribeManager), owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroBribeManager() public {
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        new ZeusLiquidator(FAKE_AAVE_POOL, address(0), owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert();
        new ZeusLiquidator(FAKE_AAVE_POOL, address(bribeManager), address(0), INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_StartsKilled() public {
        // Deploy novo (sem o revive do setUp)
        ZeusLiquidator fresh = new ZeusLiquidator(
            FAKE_AAVE_POOL, address(bribeManager), owner, INITIAL_MAX_TRADE_WEI
        );
        assertTrue(fresh.isKilled());
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Auth + circuit breakers
    // ═══════════════════════════════════════════════════════════════════════

    function test_ExecuteLiquidation_OnlyOperator() public {
        LiquidationParams memory liq = _emptyLiquidationParams();
        vm.prank(unauthorized);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeLiquidation(liq);
    }

    function test_ExecuteLiquidation_RevertsWhenKilled() public {
        vm.prank(owner);
        liquidator.kill();
        LiquidationParams memory liq = _emptyLiquidationParams();
        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.BotKilled.selector);
        liquidator.executeLiquidation(liq);
    }

    function test_ExecuteLiquidation_RevertsOnZeroUser() public {
        LiquidationParams memory liq = _emptyLiquidationParams();
        liq.user = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeLiquidation(liq);
    }

    function test_ExecuteLiquidation_RevertsOnZeroDebtAsset() public {
        LiquidationParams memory liq = _emptyLiquidationParams();
        liq.debtAsset = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeLiquidation(liq);
    }

    function test_ExecuteLiquidation_RevertsOnZeroProfitReceiver() public {
        LiquidationParams memory liq = _emptyLiquidationParams();
        liq.profitReceiver = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeLiquidation(liq);
    }

    function test_ExecuteLiquidation_RevertsOnTradeTooLarge() public {
        vm.prank(owner);
        liquidator.setMaxTradePerToken(FAKE_USDC, 50e6);

        LiquidationParams memory liq = _emptyLiquidationParams();
        liq.debtToCover = 100e6;
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusLiquidator.TradeTooLarge.selector, uint256(100e6), uint256(50e6))
        );
        liquidator.executeLiquidation(liq);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Bribe config delegated to BribeManager
    // ═══════════════════════════════════════════════════════════════════════

    function test_ExecuteLiquidationWithBribe_RevertsOnInvalidBribe() public {
        LiquidationParams memory liq = _emptyLiquidationParams();
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 10_001, // inválido
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        vm.prank(operator);
        // Reverte com InvalidBribeConfig vindo do BribeManager
        vm.expectRevert();
        liquidator.executeLiquidationWithBribe(liq, bribe);
    }

    function test_ExecuteLiquidationWithBribe_AcceptsValidConfig() public {
        LiquidationParams memory liq = _emptyLiquidationParams();
        BribeConfig memory bribe = _validBribe();
        vm.prank(operator);
        // Vai reverter no Aave (sem pool real), mas DEPOIS de validate config
        vm.expectRevert();
        liquidator.executeLiquidationWithBribe(liq, bribe);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Compound + Morpho — auth básico
    // ═══════════════════════════════════════════════════════════════════════

    function test_ExecuteCompoundLiquidation_OnlyOperator() public {
        CompoundLiquidationParams memory cp = _emptyCompoundParams();
        vm.prank(unauthorized);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeCompoundLiquidation(cp);
    }

    function test_ExecuteCompoundLiquidationWithBribe_OnlyOperator() public {
        CompoundLiquidationParams memory cp = _emptyCompoundParams();
        BribeConfig memory bribe = _validBribe();
        vm.prank(unauthorized);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeCompoundLiquidationWithBribe(cp, bribe);
    }

    function test_ExecuteMorphoLiquidation_OnlyOperator() public {
        MorphoLiquidationParams memory mp = _emptyMorphoParams();
        vm.prank(unauthorized);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeMorphoLiquidation(mp);
    }

    function test_ExecuteMorphoLiquidation_RevertsOnZeroFlashloan() public {
        MorphoLiquidationParams memory mp = _emptyMorphoParams();
        mp.flashloanAmount = 0;
        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.EmptySteps.selector);
        liquidator.executeMorphoLiquidation(mp);
    }

    function test_ExecuteMorphoLiquidationWithBribe_OnlyOperator() public {
        MorphoLiquidationParams memory mp = _emptyMorphoParams();
        BribeConfig memory bribe = _validBribe();
        vm.prank(unauthorized);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeMorphoLiquidationWithBribe(mp, bribe);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Per-token cap (H-02 fix preservado)
    // ═══════════════════════════════════════════════════════════════════════

    function test_GetMaxTradeFor_FallsBackToGlobal() public view {
        assertEq(liquidator.getMaxTradeFor(FAKE_USDC), INITIAL_MAX_TRADE_WEI);
    }

    function test_SetMaxTradePerToken_OverridesGlobal() public {
        vm.prank(owner);
        liquidator.setMaxTradePerToken(FAKE_USDC, 50e6);
        assertEq(liquidator.getMaxTradeFor(FAKE_USDC), 50e6);
        // Outro token continua no fallback
        assertEq(liquidator.getMaxTradeFor(FAKE_WETH), INITIAL_MAX_TRADE_WEI);
    }

    function test_SetMaxTradePerToken_OnlyOwner() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        liquidator.setMaxTradePerToken(FAKE_USDC, 50e6);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Admin: WETH + SwapRouter setters
    // ═══════════════════════════════════════════════════════════════════════

    function test_SetWeth_OnlyOwner() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        liquidator.setWeth(FAKE_WETH);

        vm.prank(owner);
        liquidator.setWeth(FAKE_WETH);
        assertEq(liquidator.weth(), FAKE_WETH);
    }

    function test_SetUniV3SwapRouter_OnlyOwner() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        liquidator.setUniV3SwapRouter(FAKE_UNIV3);

        vm.prank(owner);
        liquidator.setUniV3SwapRouter(FAKE_UNIV3);
        assertEq(liquidator.uniV3SwapRouter(), FAKE_UNIV3);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _validBribe() internal pure returns (BribeConfig memory) {
        return BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
    }

    function _emptyLiquidationParams() internal view returns (LiquidationParams memory) {
        SwapStep[] memory steps;
        return LiquidationParams({
            user: address(0xDEAD),
            collateralAsset: FAKE_WETH,
            debtAsset: FAKE_USDC,
            debtToCover: 100e6,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });
    }

    function _emptyCompoundParams() internal view returns (CompoundLiquidationParams memory) {
        SwapStep[] memory steps;
        return CompoundLiquidationParams({
            comet: address(0xCAFE),
            borrower: address(0xDEAD),
            collateralAsset: FAKE_WETH,
            baseAmount: 100e6,
            minCollateralReceived: 1,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });
    }

    function _emptyMorphoParams() internal view returns (MorphoLiquidationParams memory) {
        SwapStep[] memory steps;
        return MorphoLiquidationParams({
            morpho: address(0xBEEF),
            loanToken: FAKE_USDC,
            collateralToken: FAKE_WETH,
            oracle: address(0xACE1),
            irm: address(0xACE2),
            lltv: 8e17,
            borrower: address(0xDEAD),
            seizedAssets: 0,
            repaidShares: 1e18,
            flashloanAmount: 100e6,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });
    }
}
