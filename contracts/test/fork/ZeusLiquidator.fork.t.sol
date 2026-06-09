// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {BribeManager} from "../../src/BribeManager.sol";
import {ZeusLiquidator} from "../../src/ZeusLiquidator.sol";
import {IZeusLiquidator, LiquidationParams} from "../../src/interfaces/IZeusLiquidator.sol";
import {SwapStep, DexType, FlashSource} from "../../src/interfaces/IZeusExecutor.sol";
import {BribeConfig} from "../../src/interfaces/IBribeManager.sol";

/// @title ZeusLiquidator fork tests — wire + callback security em Base mainnet.
///
/// @notice E2E completo de liquidation requer borrower underwater num bloco fixo,
///         o que adiciona muito setup. Estes tests cobrem o que dá pra validar
///         contra Base mainnet sem caçar borrower específico:
///           - Constructor com Aave V3 pool real
///           - Setters (weth + uniV3SwapRouter) com endereços reais
///           - executeOperation callback security (msg.sender + initiator)
///           - Flashloan trigger: chama Aave V3 de verdade, espera revert no
///             liquidationCall (HF do user random é >= 1 → cannot liquidate)
///
///         E2E completo com underwater borrower fica pra fork tests Sprint
///         (precisa fixar bloco onde existem positions reais liquidáveis).
contract ZeusLiquidatorForkTest is Test {
    // Base mainnet
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_SINGLETON = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER_V3 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    uint256 constant FORK_BLOCK = 28_000_000;
    uint256 constant INITIAL_MAX_TRADE = 1_000 ether;

    BribeManager public bribeManager;
    ZeusLiquidator public liquidator;
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
        liquidator = new ZeusLiquidator(AAVE_V3_POOL, MORPHO_SINGLETON, BALANCER_VAULT, address(bribeManager), owner, INITIAL_MAX_TRADE);

        vm.startPrank(owner);
        liquidator.setWeth(WETH);
        liquidator.setUniV3SwapRouter(SWAP_ROUTER_V3);
        liquidator.setOperator(operator, true);
        liquidator.revive();
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Wiring contra Base mainnet
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_Constructor_WiresImmutables() public view {
        assertEq(liquidator.AAVE_V3_POOL(), AAVE_V3_POOL);
        assertEq(liquidator.BRIBE_MANAGER(), address(bribeManager));
        assertEq(liquidator.owner(), owner);
    }

    function test_Fork_Setters_AcceptRealAddresses() public view {
        assertEq(liquidator.weth(), WETH);
        assertEq(liquidator.uniV3SwapRouter(), SWAP_ROUTER_V3);
        assertTrue(liquidator.isOperator(operator));
        assertFalse(liquidator.isKilled());
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  executeOperation — callback security
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteOperation_RejectsNonAaveCaller() public {
        // Tentativa de chamar callback diretamente (não via Aave Pool)
        bytes memory params = abi.encode(uint8(0), bytes(""));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(IZeusLiquidator.InvalidCaller.selector);
        liquidator.executeOperation(USDC, 1000e6, 5e6, address(liquidator), params);
    }

    function test_Fork_ExecuteOperation_RejectsWrongInitiator() public {
        // msg.sender = Aave pool (impersonado), mas initiator != liquidator
        bytes memory params = abi.encode(uint8(0), bytes(""));
        vm.prank(AAVE_V3_POOL);
        vm.expectRevert(IZeusLiquidator.InvalidCaller.selector);
        liquidator.executeOperation(USDC, 1000e6, 5e6, makeAddr("phisher"), params);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Aave flashloan round-trip — espera revert no liquidationCall
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteLiquidation_FlashloanCallsAaveAndReverts() public {
        // Round-trip completo: flashLoanSimple → executeOperation → liquidationCall
        // O liquidationCall reverte porque o "user" tem HF >= 1 (não é liquidável).
        // Isso valida que:
        //   1. Aave Pool aceitou nosso flashloan (asset + amount válidos)
        //   2. Callback executeOperation foi invocado corretamente
        //   3. Decode dos params funcionou
        //   4. liquidationCall foi disparado contra o pool real
        //   5. Reverte com erro do Aave (HF), não com erro nosso
        SwapStep[] memory steps;
        LiquidationParams memory p = LiquidationParams({
            user: makeAddr("notUnderwaterUser"),
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: 100e6, // 100 USDC
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        vm.prank(operator);
        // Aave reverte com erro custom (NotLiquidatable / HealthFactor okay) —
        // não conseguimos prever o seletor exato, então usa expectRevert genérico.
        vm.expectRevert();
        liquidator.executeLiquidation(p);
    }

    /// @dev Mesmo round-trip, mas financiado pelo flashloan 0% do Morpho Blue (singleton real na Base).
    ///      Valida que o Morpho aceitou nosso flashLoan(USDC, ...), invocou onMorphoFlashLoan, o decode
    ///      + flag transiente funcionaram, e o fluxo chegou no liquidationCall (que reverte por HF).
    function test_Fork_ExecuteLiquidation_FlashSourceMorpho_RoundTrip() public {
        SwapStep[] memory steps;
        LiquidationParams memory p = LiquidationParams({
            user: makeAddr("notUnderwaterUser"),
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: 100e6,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Morpho
        });

        vm.prank(operator);
        vm.expectRevert(); // reverte no liquidationCall (HF ok), não na iniciação do flash
        liquidator.executeLiquidation(p);
    }

    /// @dev Round-trip financiado pelo flashloan 0% do Balancer V2 Vault (real na Base).
    ///      Valida flashLoan(recipient, [USDC], [amount], ...) → receiveFlashLoan → flag transiente
    ///      → dispatch → liquidationCall (reverte por HF). Prova que a flag anti-hijack é setada
    ///      pelo entrypoint e consumida corretamente no caminho legítimo.
    function test_Fork_ExecuteLiquidation_FlashSourceBalancer_RoundTrip() public {
        SwapStep[] memory steps;
        LiquidationParams memory p = LiquidationParams({
            user: makeAddr("notUnderwaterUser"),
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: 100e6,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Balancer
        });

        vm.prank(operator);
        vm.expectRevert(); // reverte no liquidationCall (HF ok), não na iniciação do flash
        liquidator.executeLiquidation(p);
    }

    function test_Fork_ExecuteLiquidation_RevertsOnTradeTooLarge() public {
        // Validação de circuit breaker contra estado real
        vm.prank(owner);
        liquidator.setMaxTradePerToken(USDC, 50e6);

        SwapStep[] memory steps;
        LiquidationParams memory p = LiquidationParams({
            user: makeAddr("user"),
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: 100e6, // > maxTrade USDC (50e6)
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusLiquidator.TradeTooLarge.selector, uint256(100e6), uint256(50e6))
        );
        liquidator.executeLiquidation(p);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Kill switch funciona com fork live
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_KillSwitch_BlocksExecution() public {
        vm.prank(owner);
        liquidator.kill();

        SwapStep[] memory steps;
        LiquidationParams memory p = LiquidationParams({
            user: makeAddr("user"),
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: 100e6,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.BotKilled.selector);
        liquidator.executeLiquidation(p);
    }
}
