// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ZeusExecutor} from "../../src/ZeusExecutor.sol";
import {
    IZeusExecutor,
    SwapStep,
    LiquidationParams,
    DexType
} from "../../src/interfaces/IZeusExecutor.sol";
import {IPool} from "../../src/interfaces/aave/IPool.sol";

/// @notice Interface mínima do Aave V3 Pool para criar position de teste
interface IAavePoolExtended is IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;
    function getReserveData(address asset) external view returns (
        // Aave V3 ReserveData struct (simplificado pra get currentLiquidationThreshold)
        uint256 configuration,
        uint128 liquidityIndex,
        uint128 currentLiquidityRate,
        uint128 variableBorrowIndex,
        uint128 currentVariableBorrowRate,
        uint128 currentStableBorrowRate,
        uint40 lastUpdateTimestamp,
        uint16 id,
        address aTokenAddress,
        address stableDebtTokenAddress,
        address variableDebtTokenAddress,
        address interestRateStrategyAddress,
        uint128 accruedToTreasury,
        uint128 unbacked,
        uint128 isolationModeTotalDebt
    );
}

/// @notice Aave V3 PriceOracle interface mínima
interface IPriceOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

/// @title ZeusExecutorLiquidationForkTest — fork tests de executeLiquidation
/// @notice Cria uma position artificial em fork mainnet, manipula preço via mock,
///         e dispara liquidação pra validar mecânica completa.
/// @dev Rodar: forge test --match-path test/fork/ZeusExecutor.liquidation.t.sol --fork-url $RPC -vv
contract ZeusExecutorLiquidationForkTest is Test {
    // ─── Endereços Base Mainnet ───
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant AAVE_V3_ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;
    address constant UNI_V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint24 constant UNI_V3_FEE_005 = 500;

    ZeusExecutor public executor;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");
    address public victim = makeAddr("victim");

    modifier onlyFork() {
        try vm.activeFork() returns (uint256) {
            _;
        } catch {
            console2.log("Skipping fork test - no active fork");
            return;
        }
    }

    function setUp() public {
        try vm.envString("BASE_RPC_HTTP") returns (string memory rpc) {
            vm.createSelectFork(rpc);
        } catch {}

        // Deploy executor + ativa + autoriza operator
        executor = new ZeusExecutor(AAVE_V3_POOL, owner, 1_000_000 ether);
        vm.startPrank(owner);
        executor.revive();
        executor.setOperator(operator, true);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Helper: cria position liquidável (victim deposita WETH, empresta USDC,
    //  depois mockamos preço de WETH pra HF cair abaixo de 1.0)
    // ─────────────────────────────────────────────────────────────────────
    function _createLiquidatablePosition(uint256 collateralWeth, uint256 borrowUsdc) internal {
        // 1. Dá WETH pro victim
        deal(WETH, victim, collateralWeth);

        // 2. Victim deposita WETH como colateral
        vm.startPrank(victim);
        IERC20(WETH).approve(AAVE_V3_POOL, collateralWeth);
        IAavePoolExtended(AAVE_V3_POOL).supply(WETH, collateralWeth, victim, 0);

        // 3. Victim toma emprestado USDC (variable rate = 2)
        IAavePoolExtended(AAVE_V3_POOL).borrow(USDC, borrowUsdc, 2, 0, victim);
        vm.stopPrank();

        // 4. Verifica HF saudável
        (, , , , , uint256 hfBefore) = IPool(AAVE_V3_POOL).getUserAccountData(victim);
        console2.log("HF apos borrow (1e18 base):", hfBefore);
        assertGt(hfBefore, 1e18, "Position deveria estar saudavel apos borrow");
    }

    /// @dev Mocka o preço de WETH no oracle pra X% do valor original
    /// Faz HF cair drasticamente, tornando position liquidável.
    function _crashWethPriceTo(uint256 percentOfOriginal) internal {
        uint256 originalPrice = IPriceOracle(AAVE_V3_ORACLE).getAssetPrice(WETH);
        uint256 newPrice = (originalPrice * percentOfOriginal) / 100;

        // vm.mockCall: substitui retorno de getAssetPrice(WETH) pelo novo preço
        vm.mockCall(
            AAVE_V3_ORACLE,
            abi.encodeWithSelector(IPriceOracle.getAssetPrice.selector, WETH),
            abi.encode(newPrice)
        );

        console2.log("WETH price antes (1e8 USD):", originalPrice);
        console2.log("WETH price agora  (1e8 USD):", newPrice);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 1 — Liquidação básica: victim insolvente → bot liquida + lucra
    // ─────────────────────────────────────────────────────────────────────
    function test_Liquidation_GeneratesProfit() public onlyFork {
        // ─── 1) Cria position saudável ───
        uint256 collateralAmount = 10 ether; // 10 WETH (~$21k a $2.1k/ETH)
        uint256 borrowAmount = 12_000e6; // $12k USDC (LTV ~57%, dentro do max 80% do WETH)

        _createLiquidatablePosition(collateralAmount, borrowAmount);

        // ─── 2) Crashea preço do WETH pra 60% (HF cai abaixo de 1.0) ───
        _crashWethPriceTo(60);

        (, , , , , uint256 hfAfterCrash) = IPool(AAVE_V3_POOL).getUserAccountData(victim);
        console2.log("HF apos crash (1e18 base):", hfAfterCrash);
        assertLt(hfAfterCrash, 1e18, "Position deveria estar liquidavel apos crash");

        // ─── 3) Bot dispara executeLiquidation ───
        // Close factor: HF > 0.95 → 50% da dívida; HF <= 0.95 → 100%
        uint256 debtToCover = hfAfterCrash < 95e16
            ? borrowAmount       // 100%
            : borrowAmount / 2;  // 50%

        console2.log("Debt to cover (USDC raw):", debtToCover);

        // Constrói swapStep: WETH (recebido como colateral) → USDC (pra repay)
        SwapStep[] memory swapSteps = new SwapStep[](1);
        swapSteps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: 0, // usa saldo atual de WETH (= colateral recebido + bonus)
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        LiquidationParams memory params = LiquidationParams({
            user: victim,
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: debtToCover,
            swapSteps: swapSteps,
            minProfitWei: 1, // exige profit > 0 (mas o swap pode comer parte pela slippage)
            profitReceiver: profitReceiver
        });

        uint256 receiverBefore = IERC20(USDC).balanceOf(profitReceiver);

        // ─── 4) Executa ───
        vm.prank(operator);
        executor.executeLiquidation(params);

        // ─── 5) Asserta profit ───
        uint256 receiverAfter = IERC20(USDC).balanceOf(profitReceiver);
        uint256 profit = receiverAfter - receiverBefore;

        console2.log("=== Liquidation Result ===");
        console2.log("Debt covered (USDC raw): ", debtToCover);
        console2.log("Profit USDC raw:         ", profit);
        console2.log("Profit em $:             ", profit / 1e6);

        assertGt(profit, 0, "Liquidacao deveria gerar profit positivo");
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 2 — Reverte se HF do user > 1.0 (não-liquidável)
    // ─────────────────────────────────────────────────────────────────────
    function test_Liquidation_RevertsIfNotLiquidatable() public onlyFork {
        // Cria position saudável e NÃO crashea o preço
        _createLiquidatablePosition(10 ether, 8_000e6);

        SwapStep[] memory swapSteps = new SwapStep[](1);
        swapSteps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: 0,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        LiquidationParams memory params = LiquidationParams({
            user: victim,
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: 4_000e6,
            swapSteps: swapSteps,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });

        vm.prank(operator);
        // Aave reverte com erro próprio (HEALTH_FACTOR_NOT_BELOW_THRESHOLD)
        vm.expectRevert();
        executor.executeLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 3 — Reverte pra non-operator
    // ─────────────────────────────────────────────────────────────────────
    function test_Liquidation_RevertsForNonOperator() public onlyFork {
        SwapStep[] memory empty = new SwapStep[](0);
        LiquidationParams memory params = LiquidationParams({
            user: victim,
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: 1000e6,
            swapSteps: empty,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });

        address randomUser = makeAddr("random");
        vm.prank(randomUser);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 4 — Reverte se debtToCover > maxTradeWei
    // ─────────────────────────────────────────────────────────────────────
    function test_Liquidation_RevertsOnAmountAboveCap() public onlyFork {
        // Diminui o cap pra 100 USDC pra forçar revert
        vm.prank(owner);
        executor.setMaxTradeWei(100e6);

        SwapStep[] memory empty = new SwapStep[](0);
        LiquidationParams memory params = LiquidationParams({
            user: victim,
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: 1000e6, // acima do cap
            swapSteps: empty,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IZeusExecutor.TradeTooLarge.selector, 1000e6, 100e6));
        executor.executeLiquidation(params);
    }
}
