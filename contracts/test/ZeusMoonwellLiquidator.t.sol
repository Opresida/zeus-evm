// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {ZeusMoonwellLiquidator} from "../src/ZeusMoonwellLiquidator.sol";
import {IZeusMoonwellLiquidator, MoonwellLiquidationParams} from "../src/interfaces/IZeusMoonwellLiquidator.sol";
import {SwapStep, DexType} from "../src/interfaces/IZeusExecutor.sol";

/// @title ZeusMoonwellLiquidatorTest — adversariais:
///   1. Constructor (Aave Pool + owner + maxTrade + starts killed)
///   2. Auth (operator gate, kill switch)
///   3. Param validation (zero addresses, zero amounts)
///   4. Per-token cap (TradeTooLarge)
///   5. Admin (setOperator, setMaxTrade, rescue, kill/revive)
///   6. Callback access control (só Aave pool + initiator self)
contract ZeusMoonwellLiquidatorTest is Test {
    ZeusMoonwellLiquidator public liq;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public unauthorized = makeAddr("unauthorized");
    address public profitReceiver = makeAddr("profitReceiver");

    address constant FAKE_AAVE_POOL = address(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
    address constant FAKE_MORPHO = address(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    address constant FAKE_BALANCER = address(0xBA12222222228d8Ba445958a75a0704d566BF2C8);
    address constant FAKE_USDC = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address constant FAKE_WETH = address(0x4200000000000000000000000000000000000006);
    address constant FAKE_MUSDC = address(0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22); // Moonwell mUSDC Base
    address constant FAKE_MWETH = address(0x628ff693426583D9a7FB391E54366292F509D457); // Moonwell mWETH Base
    address constant borrower = address(0xdEADbeEF00000000000000000000000000000001);

    uint256 public constant INITIAL_MAX_TRADE_WEI = 100 ether;

    function setUp() public {
        liq = new ZeusMoonwellLiquidator(FAKE_AAVE_POOL, FAKE_MORPHO, FAKE_BALANCER, owner, INITIAL_MAX_TRADE_WEI);
        vm.startPrank(owner);
        liq.revive();
        liq.setOperator(operator, true);
        vm.stopPrank();
    }

    function _params() internal view returns (MoonwellLiquidationParams memory p) {
        p.mTokenBorrowed = FAKE_MUSDC;
        p.borrowedUnderlying = FAKE_USDC;
        p.mTokenCollateral = FAKE_MWETH;
        p.collateralUnderlying = FAKE_WETH;
        p.borrower = borrower;
        p.repayAmount = 1000e6;
        p.flashloanAmount = 1000e6;
        p.swapSteps = new SwapStep[](0);
        p.minProfitWei = 1;
        p.profitReceiver = profitReceiver;
    }

    // ─── Constructor ───

    function test_Constructor_SetsImmutables() public view {
        assertEq(liq.AAVE_V3_POOL(), FAKE_AAVE_POOL);
        assertEq(liq.owner(), owner);
        assertEq(liq.maxTradeWei(), INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroAavePool() public {
        vm.expectRevert(IZeusMoonwellLiquidator.NotAuthorized.selector);
        new ZeusMoonwellLiquidator(address(0), FAKE_MORPHO, FAKE_BALANCER, owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroMorpho() public {
        vm.expectRevert(IZeusMoonwellLiquidator.NotAuthorized.selector);
        new ZeusMoonwellLiquidator(FAKE_AAVE_POOL, address(0), FAKE_BALANCER, owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroBalancer() public {
        vm.expectRevert(IZeusMoonwellLiquidator.NotAuthorized.selector);
        new ZeusMoonwellLiquidator(FAKE_AAVE_POOL, FAKE_MORPHO, address(0), owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert();
        new ZeusMoonwellLiquidator(FAKE_AAVE_POOL, FAKE_MORPHO, FAKE_BALANCER, address(0), INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_StartsKilled() public {
        ZeusMoonwellLiquidator fresh =
            new ZeusMoonwellLiquidator(FAKE_AAVE_POOL, FAKE_MORPHO, FAKE_BALANCER, owner, INITIAL_MAX_TRADE_WEI);
        assertTrue(fresh.isKilled());
    }

    // ─── Auth ───

    function test_Execute_RevertsIfNotOperator() public {
        vm.prank(unauthorized);
        vm.expectRevert(IZeusMoonwellLiquidator.NotAuthorized.selector);
        liq.executeMoonwellLiquidation(_params());
    }

    function test_Execute_RevertsIfKilled() public {
        vm.prank(owner);
        liq.kill();
        vm.prank(operator);
        vm.expectRevert(IZeusMoonwellLiquidator.BotKilled.selector);
        liq.executeMoonwellLiquidation(_params());
    }

    // ─── Param validation ───

    function test_Execute_RevertsOnZeroBorrower() public {
        MoonwellLiquidationParams memory p = _params();
        p.borrower = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusMoonwellLiquidator.NotAuthorized.selector);
        liq.executeMoonwellLiquidation(p);
    }

    function test_Execute_RevertsOnZeroMToken() public {
        MoonwellLiquidationParams memory p = _params();
        p.mTokenBorrowed = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusMoonwellLiquidator.NotAuthorized.selector);
        liq.executeMoonwellLiquidation(p);
    }

    function test_Execute_RevertsOnZeroProfitReceiver() public {
        MoonwellLiquidationParams memory p = _params();
        p.profitReceiver = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusMoonwellLiquidator.NotAuthorized.selector);
        liq.executeMoonwellLiquidation(p);
    }

    function test_Execute_RevertsOnZeroRepayAmount() public {
        MoonwellLiquidationParams memory p = _params();
        p.repayAmount = 0;
        vm.prank(operator);
        vm.expectRevert(IZeusMoonwellLiquidator.EmptySteps.selector);
        liq.executeMoonwellLiquidation(p);
    }

    // ─── Per-token cap ───

    function test_Execute_RevertsWhenFlashloanExceedsCap() public {
        vm.prank(owner);
        liq.setMaxTradePerToken(FAKE_USDC, 500e6);
        MoonwellLiquidationParams memory p = _params();
        p.flashloanAmount = 1000e6; // > 500e6 cap
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IZeusMoonwellLiquidator.TradeTooLarge.selector, 1000e6, 500e6));
        liq.executeMoonwellLiquidation(p);
    }

    // ─── Callback access control ───

    function test_ExecuteOperation_RevertsIfNotAavePool() public {
        vm.prank(unauthorized);
        vm.expectRevert(IZeusMoonwellLiquidator.InvalidCaller.selector);
        liq.executeOperation(FAKE_USDC, 1000e6, 5e5, address(liq), "");
    }

    function test_ExecuteOperation_RevertsIfInitiatorNotSelf() public {
        vm.prank(FAKE_AAVE_POOL);
        vm.expectRevert(IZeusMoonwellLiquidator.InvalidCaller.selector);
        liq.executeOperation(FAKE_USDC, 1000e6, 5e5, unauthorized, "");
    }

    // ─── Admin ───

    function test_Admin_KillReviveCycle() public {
        vm.startPrank(owner);
        liq.kill();
        assertTrue(liq.isKilled());
        liq.revive();
        assertFalse(liq.isKilled());
        vm.stopPrank();
    }

    function test_Admin_OnlyOwnerCanKill() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        liq.kill();
    }

    function test_Admin_SetMaxTradePerToken() public {
        vm.prank(owner);
        liq.setMaxTradePerToken(FAKE_USDC, 42e6);
        assertEq(liq.getMaxTradeFor(FAKE_USDC), 42e6);
        // Token sem override usa global
        assertEq(liq.getMaxTradeFor(FAKE_WETH), INITIAL_MAX_TRADE_WEI);
    }

    function test_Admin_SetOperator() public {
        vm.prank(owner);
        liq.setOperator(unauthorized, true);
        assertTrue(liq.isOperator(unauthorized));
    }

    function test_Admin_OnlyOwnerCanSetOperator() public {
        vm.prank(operator);
        vm.expectRevert();
        liq.setOperator(unauthorized, true);
    }
}
