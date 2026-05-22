// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ZeusExecutor} from "../src/ZeusExecutor.sol";
import {IZeusExecutor, SwapStep, ArbitrageParams, DexType} from "../src/interfaces/IZeusExecutor.sol";

/// @title ZeusExecutorTest — testes unitários básicos (sem fork)
/// @notice Foco em:
///         - Construtor + invariants iniciais
///         - Kill switch / pause / access control
///         - Custom errors no fluxo de revert
///         - Admin functions
/// @dev Testes com fork de Base mainnet ficam em test/fork/ (criados quando RPC estiver disponível)
contract ZeusExecutorTest is Test {
    ZeusExecutor public executor;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public unauthorized = makeAddr("unauthorized");
    address public profitReceiver = makeAddr("profitReceiver");

    // Endereço fictício do Aave pool (não vai ser chamado nesses tests)
    address public constant FAKE_AAVE_POOL = address(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);

    uint256 public constant INITIAL_MAX_TRADE_WEI = 0.5 ether;

    function setUp() public {
        executor = new ZeusExecutor(FAKE_AAVE_POOL, owner, INITIAL_MAX_TRADE_WEI);
    }

    // ════════ CONSTRUCTOR ════════

    function test_Constructor_SetsInitialState() public view {
        assertEq(executor.owner(), owner, "owner");
        assertEq(executor.AAVE_V3_POOL(), FAKE_AAVE_POOL, "aave pool");
        assertEq(executor.maxTradeWei(), INITIAL_MAX_TRADE_WEI, "max trade wei");
        assertTrue(executor.isKilled(), "should start killed (fail-safe)");
        assertFalse(executor.paused(), "should start unpaused");
    }

    function test_Constructor_RevertsOnZeroAavePool() public {
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        new ZeusExecutor(address(0), owner, INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        // OpenZeppelin Ownable já protege contra zero address antes da nossa checagem
        vm.expectRevert();
        new ZeusExecutor(FAKE_AAVE_POOL, address(0), INITIAL_MAX_TRADE_WEI);
    }

    // ════════ KILL SWITCH ════════

    function test_Revive_OnlyOwner() public {
        vm.prank(owner);
        executor.revive();
        assertFalse(executor.isKilled(), "should be alive");
    }

    function test_Revive_RevertsForNonOwner() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        executor.revive();
    }

    function test_Kill_OnlyOwner() public {
        vm.prank(owner);
        executor.revive();
        vm.prank(owner);
        executor.kill();
        assertTrue(executor.isKilled(), "should be killed");
    }

    function test_ExecuteArbitrage_RevertsWhenKilled() public {
        // Contrato começa killed por padrão
        SwapStep[] memory steps = new SwapStep[](1);
        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: address(0x1),
            profitReceiver: profitReceiver
        });

        vm.prank(owner);
        vm.expectRevert(IZeusExecutor.BotKilled.selector);
        executor.executeArbitrage(params);
    }

    function test_ExecuteArbitrage_RevertsForNonOperator() public {
        vm.prank(owner);
        executor.revive();

        SwapStep[] memory steps = new SwapStep[](1);
        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: address(0x1),
            profitReceiver: profitReceiver
        });

        vm.prank(unauthorized);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeArbitrage(params);
    }

    // ════════ OPERATOR MANAGEMENT ════════

    function test_SetOperator_OnlyOwner() public {
        vm.prank(owner);
        executor.setOperator(operator, true);
        assertTrue(executor.isOperator(operator), "should be operator");
    }

    function test_SetOperator_RevertsForNonOwner() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        executor.setOperator(operator, true);
    }

    function test_RemoveOperator() public {
        vm.startPrank(owner);
        executor.setOperator(operator, true);
        assertTrue(executor.isOperator(operator));
        executor.setOperator(operator, false);
        assertFalse(executor.isOperator(operator));
        vm.stopPrank();
    }

    // ════════ MAX TRADE WEI ════════

    function test_SetMaxTradeWei() public {
        uint256 newMax = 1 ether;
        vm.prank(owner);
        executor.setMaxTradeWei(newMax);
        assertEq(executor.maxTradeWei(), newMax);
    }

    function test_SetMaxTradeWei_RevertsForNonOwner() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        executor.setMaxTradeWei(1 ether);
    }

    // ════════ PAUSABLE ════════

    function test_Pause_OnlyOwner() public {
        vm.prank(owner);
        executor.pause();
        assertTrue(executor.paused());
    }

    function test_ExecuteArbitrage_RevertsWhenPaused() public {
        vm.startPrank(owner);
        executor.revive(); // ativa
        executor.pause();  // mas pausa
        vm.stopPrank();

        SwapStep[] memory steps = new SwapStep[](1);
        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: address(0x1),
            profitReceiver: profitReceiver
        });

        vm.prank(owner);
        vm.expectRevert(); // Pausable: paused
        executor.executeArbitrage(params);
    }

    // ════════ EMPTY STEPS ════════

    function test_ExecuteArbitrage_RevertsOnEmptySteps() public {
        vm.prank(owner);
        executor.revive();

        SwapStep[] memory steps = new SwapStep[](0);
        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: address(0x1),
            profitReceiver: profitReceiver
        });

        vm.prank(owner);
        vm.expectRevert(IZeusExecutor.EmptySteps.selector);
        executor.executeArbitrage(params);
    }

    // ════════ FLASHLOAN VALIDATIONS ════════

    function test_ExecuteFlashloan_RevertsOnTradeTooLarge() public {
        vm.prank(owner);
        executor.revive();

        SwapStep[] memory steps = new SwapStep[](1);
        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: address(0x1),
            profitReceiver: profitReceiver
        });

        uint256 tooLarge = INITIAL_MAX_TRADE_WEI + 1;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IZeusExecutor.TradeTooLarge.selector, tooLarge, INITIAL_MAX_TRADE_WEI));
        executor.executeFlashloanArbitrage(address(0x1), tooLarge, params);
    }

    // ════════ AAVE CALLBACK SECURITY ════════

    function test_ExecuteOperation_RevertsIfNotAavePool() public {
        vm.prank(unauthorized);
        vm.expectRevert(IZeusExecutor.InvalidCaller.selector);
        executor.executeOperation(address(0x1), 100, 1, address(executor), "");
    }
}
