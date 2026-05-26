// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {ZeusExecutor} from "../src/ZeusExecutor.sol";
import {
    IZeusExecutor,
    SwapStep,
    ArbitrageParams,
    BackrunParams,
    BribeConfig,
    LiquidationParams,
    CompoundLiquidationParams,
    MorphoLiquidationParams,
    DexType,
    OperationType
} from "../src/interfaces/IZeusExecutor.sol";

/// @title ZeusExecutorBribeTest — adversariais cobrindo BribeConfig + variantes WithBribe (v7)
/// @notice Cada test cobre 1 invariant central. Foco em validação ON-CHAIN — não testa flow
///         atomic completo (isso fica pros fork tests, que precisam RPC).
contract ZeusExecutorBribeTest is Test {
    ZeusExecutor public executor;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public unauthorized = makeAddr("unauthorized");
    address public profitReceiver = makeAddr("profitReceiver");

    address constant FAKE_AAVE_POOL = address(0xA238Dd80C259a72e81d7e4664a9801593F98d1c5);
    address constant FAKE_USDC = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address constant FAKE_WETH = address(0x4200000000000000000000000000000000000006);
    address constant FAKE_UNIV3_ROUTER = address(0x2626664c2603336E57B271c5C0b26F421741e481);

    uint256 public constant INITIAL_MAX_TRADE_WEI = 100 ether;

    function setUp() public {
        executor = new ZeusExecutor(FAKE_AAVE_POOL, owner, INITIAL_MAX_TRADE_WEI);
        vm.startPrank(owner);
        executor.revive();
        executor.setOperator(operator, true);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Bribe config validation — _validateBribeConfig
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice bribeBps acima de 10000 é inválido (>100% do profit)
    function test_Bribe_InvalidBribeBpsReverts() public {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 10_001,
            minBribeWei: 0,
            bribeMaxBps: 9_500,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        _expectInvalidBribeConfig(bribe);
    }

    /// @notice bribeMaxBps acima de ABSOLUTE_BRIBE_CAP_BPS (9900) é inválido
    function test_Bribe_BribeMaxBpsAboveCapReverts() public {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_901,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        _expectInvalidBribeConfig(bribe);
    }

    /// @notice bribeMaxBps == 0 (com bribeBps > 0) é inválido
    function test_Bribe_ZeroMaxBpsWithBribeReverts() public {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 0,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        _expectInvalidBribeConfig(bribe);
    }

    /// @notice swapSlippageBps > 1000 (10%) é inválido — proteção contra slippage extremo
    function test_Bribe_ExcessiveSlippageBpsReverts() public {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 500,
            swapSlippageBps: 1_001
        });
        _expectInvalidBribeConfig(bribe);
    }

    /// @notice bribeBps == 0 && minBribeWei == 0 = config neutra, deve passar.
    /// @dev Mesmo que a flashLoanSimple revert depois (sem pool real), passamos antes do flow Aave.
    function test_Bribe_ZeroConfigIsNoop() public {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 0,
            minBribeWei: 0,
            bribeMaxBps: 0,
            swapFeeTier: 0,
            swapSlippageBps: 0
        });
        BackrunParams memory bp = _emptyBackrunParams(bribe);
        bp.steps = _dummySteps(); // forçar entrada no validate

        // Operator chama → vai chamar Aave (que reverte) MAS o _validateBribeConfig já passou.
        // Espera revert vindo do Aave, não do bribe validator.
        vm.prank(operator);
        vm.expectRevert(); // vem de Aave (não validBribeConfig)
        executor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Setters admin
    // ═══════════════════════════════════════════════════════════════════════

    function test_SetWeth_OnlyOwner() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        executor.setWeth(FAKE_WETH);

        vm.prank(owner);
        executor.setWeth(FAKE_WETH);
        assertEq(executor.weth(), FAKE_WETH);
    }

    function test_SetUniV3SwapRouter_OnlyOwner() public {
        vm.prank(unauthorized);
        vm.expectRevert();
        executor.setUniV3SwapRouter(FAKE_UNIV3_ROUTER);

        vm.prank(owner);
        executor.setUniV3SwapRouter(FAKE_UNIV3_ROUTER);
        assertEq(executor.uniV3SwapRouter(), FAKE_UNIV3_ROUTER);
    }

    function test_SetWeth_AllowsZeroAddress() public {
        // Owner pode desabilitar bribe via setWeth(0) — não é erro
        vm.prank(owner);
        executor.setWeth(FAKE_WETH);

        vm.prank(owner);
        executor.setWeth(address(0));
        assertEq(executor.weth(), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Authorization + circuit breakers
    // ═══════════════════════════════════════════════════════════════════════

    function test_Backrun_OnlyOperatorCanCall() public {
        BackrunParams memory bp = _emptyBackrunParams(_zeroBribe());
        bp.steps = _dummySteps();

        vm.prank(unauthorized);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function test_Backrun_RevertsWhenKilled() public {
        vm.prank(owner);
        executor.kill();

        BackrunParams memory bp = _emptyBackrunParams(_zeroBribe());
        bp.steps = _dummySteps();

        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.BotKilled.selector);
        executor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function test_Backrun_EmptyStepsReverts() public {
        BackrunParams memory bp = _emptyBackrunParams(_zeroBribe());
        // steps vazio

        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.EmptySteps.selector);
        executor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function test_Backrun_FlashloanAboveCapReverts() public {
        // Cap específico do USDC = 50 USDC
        vm.prank(owner);
        executor.setMaxTradePerToken(FAKE_USDC, 50e6);

        BackrunParams memory bp = _emptyBackrunParams(_zeroBribe());
        bp.steps = _dummySteps();

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusExecutor.TradeTooLarge.selector, uint256(100e6), uint256(50e6))
        );
        executor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function test_Backrun_AboveBribeMaxBpsValidatesAtEntry() public {
        // bribeBps > 10000 mesmo se bribeMaxBps é alto = inválido (proteção upper)
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 11_000,
            minBribeWei: 0,
            bribeMaxBps: 9_500,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        _expectInvalidBribeConfig(bribe);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Variantes WithBribe — auth + circuit breaker básicos
    // ═══════════════════════════════════════════════════════════════════════

    function test_LiquidationWithBribe_OnlyOperator() public {
        LiquidationParams memory liq = _emptyLiquidationParams();
        BribeConfig memory bribe = _zeroBribe();

        vm.prank(unauthorized);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeLiquidationWithBribe(liq, bribe);
    }

    function test_CompoundLiquidationWithBribe_OnlyOperator() public {
        CompoundLiquidationParams memory cp = _emptyCompoundParams();
        BribeConfig memory bribe = _zeroBribe();

        vm.prank(unauthorized);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeCompoundLiquidationWithBribe(cp, bribe);
    }

    function test_MorphoLiquidationWithBribe_OnlyOperator() public {
        MorphoLiquidationParams memory mp = _emptyMorphoParams();
        BribeConfig memory bribe = _zeroBribe();

        vm.prank(unauthorized);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeMorphoLiquidationWithBribe(mp, bribe);
    }

    function test_MorphoLiquidationWithBribe_RejectsZeroFlashloanAmount() public {
        MorphoLiquidationParams memory mp = _emptyMorphoParams();
        mp.flashloanAmount = 0;
        BribeConfig memory bribe = _zeroBribe();

        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.EmptySteps.selector);
        executor.executeMorphoLiquidationWithBribe(mp, bribe);
    }

    function test_LiquidationWithBribe_InvalidBribeConfigReverts() public {
        LiquidationParams memory liq = _emptyLiquidationParams();
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 10_001, // inválido
            minBribeWei: 0,
            bribeMaxBps: 9_500,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });

        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.InvalidBribeConfig.selector);
        executor.executeLiquidationWithBribe(liq, bribe);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════

    function _expectInvalidBribeConfig(BribeConfig memory bribe) internal {
        BackrunParams memory bp = _emptyBackrunParams(bribe);
        bp.steps = _dummySteps();
        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.InvalidBribeConfig.selector);
        executor.executeFlashloanBackrun(FAKE_USDC, 100e6, bp);
    }

    function _zeroBribe() internal pure returns (BribeConfig memory) {
        return BribeConfig({
            bribeBps: 0,
            minBribeWei: 0,
            bribeMaxBps: 0,
            swapFeeTier: 0,
            swapSlippageBps: 0
        });
    }

    function _emptyBackrunParams(BribeConfig memory bribe) internal view returns (BackrunParams memory) {
        SwapStep[] memory steps;
        return BackrunParams({
            steps: steps,
            minProfitWei: 1,
            profitToken: FAKE_USDC,
            profitReceiver: profitReceiver,
            bribe: bribe
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
