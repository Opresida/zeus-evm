// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BribeManager} from "../../src/BribeManager.sol";
import {ZeusArbExecutor} from "../../src/ZeusArbExecutor.sol";
import {ZeusLiquidator} from "../../src/ZeusLiquidator.sol";
import {IZeusArbExecutor, BackrunParams} from "../../src/interfaces/IZeusArbExecutor.sol";
import {IZeusLiquidator, LiquidationParams} from "../../src/interfaces/IZeusLiquidator.sol";
import {SwapStep, ArbitrageParams, DexType, FlashSource} from "../../src/interfaces/IZeusExecutor.sol";
import {BribeConfig} from "../../src/interfaces/IBribeManager.sol";

interface IUniRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function getUserAccountData(address user)
        external view
        returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor);
    function ADDRESSES_PROVIDER() external view returns (address);
}

interface IAddressesProvider { function getPriceOracle() external view returns (address); }
interface IAaveOracle { function getAssetPrice(address asset) external view returns (uint256); }

/// @title MotorsProfit fork tests — prova de LUCRO ponta-a-ponta dos 3 motores via flashloan,
///        contra a Base mainnet (fork). Usa Alchemy (ver fork-test.sh).
///
/// Técnica: "quebramos o preço" no fork (whale dump / oracle drop) pra criar a condição que
/// cada motor explora, e validamos que a lógica fecha LUCRO + paga o flashloan.
contract MotorsProfitForkTest is Test {
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_SINGLETON = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER_V3 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    uint256 constant FORK_BLOCK = 28_000_000;
    uint256 constant MAX_TRADE = 1_000_000_000 ether; // cap alto: foco é provar lucro, não o cap

    BribeManager public bribeManager;
    ZeusArbExecutor public arb;
    ZeusLiquidator public liq;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_HTTP", string(""));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpc, FORK_BLOCK);

        bribeManager = new BribeManager();
        arb = new ZeusArbExecutor(AAVE_V3_POOL, MORPHO_SINGLETON, BALANCER_VAULT, address(bribeManager), owner, MAX_TRADE);
        liq = new ZeusLiquidator(AAVE_V3_POOL, MORPHO_SINGLETON, BALANCER_VAULT, address(bribeManager), owner, MAX_TRADE);

        vm.startPrank(owner);
        arb.setWeth(WETH); arb.setUniV3SwapRouter(SWAP_ROUTER_V3); arb.setOperator(operator, true); arb.revive(); arb.setApprovedRouter(SWAP_ROUTER_V3, true);
        liq.setWeth(WETH); liq.setUniV3SwapRouter(SWAP_ROUTER_V3); liq.setOperator(operator, true); liq.revive(); liq.setApprovedRouter(SWAP_ROUTER_V3, true);
        vm.stopPrank();
    }

    /// Whale dump: vende `wethIn` WETH no pool 3000 (raso) → WETH fica BARATO nesse pool.
    function _dumpWethOn3000(uint256 wethIn) internal {
        deal(WETH, address(this), wethIn);
        IERC20(WETH).approve(SWAP_ROUTER_V3, wethIn);
        IUniRouter(SWAP_ROUTER_V3).exactInputSingle(IUniRouter.ExactInputSingleParams({
            tokenIn: WETH, tokenOut: USDC, fee: 3000, recipient: address(this), amountIn: wethIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
    }

    function _arbSteps() internal pure returns (SwapStep[] memory steps) {
        steps = new SwapStep[](2);
        // leg1: compra WETH BARATO no pool 3000 dislocado (USDC→WETH)
        steps[0] = SwapStep({ router: SWAP_ROUTER_V3, tokenIn: USDC, tokenOut: WETH, amountIn: 30_000e6, minAmountOut: 0, dexType: DexType.UniswapV3, extraData: abi.encode(uint24(3000)) });
        // leg2: vende WETH no pool 500 (fundo, preço normal) → mais USDC (amountIn=0 = saldo todo)
        steps[1] = SwapStep({ router: SWAP_ROUTER_V3, tokenIn: WETH, tokenOut: USDC, amountIn: 0, minAmountOut: 0, dexType: DexType.UniswapV3, extraData: abi.encode(uint24(500)) });
    }

    // ═══════════════ MOTOR 2 — Cross-DEX Arb via flashloan ═══════════════
    function test_Fork_Motor2_FlashloanArb_Profits() public {
        _dumpWethOn3000(800 ether); // cria a dislocação (custo nosso, simula a ineficiência)
        uint256 flash = 30_000e6; // flashloan modesto: captura o gap sem desfazer a dislocação

        ArbitrageParams memory p = ArbitrageParams({ steps: _arbSteps(), minProfitWei: 1, profitToken: USDC, profitReceiver: profitReceiver, flashSource: FlashSource.Aave });
        uint256 before = IERC20(USDC).balanceOf(profitReceiver);

        vm.prank(operator);
        arb.executeFlashloanArbitrage(USDC, flash, p);

        uint256 profit = IERC20(USDC).balanceOf(profitReceiver) - before;
        emit log_named_decimal_uint("Motor2 flashloan arb - lucro liquido (USDC)", profit, 6);
        assertGt(profit, 0, "arb deveria fechar lucro apos devolver flashloan + premium");
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "contrato deve ficar limpo");
    }

    // ═══════════════ MOTOR 3 — Backrun via flashloan (+ bribe) ═══════════════
    function test_Fork_Motor3_FlashloanBackrun_Profits() public {
        _dumpWethOn3000(800 ether); // = o swap da "baleia" que disloca o preço
        uint256 flash = 30_000e6;

        BackrunParams memory bp = BackrunParams({
            steps: _arbSteps(),
            minProfitWei: 1,
            profitToken: USDC,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave,
            bribe: BribeConfig({ bribeBps: 1_000, minBribeWei: 0, bribeMaxBps: 5_000, swapFeeTier: 500, swapSlippageBps: 300 })
        });
        uint256 before = IERC20(USDC).balanceOf(profitReceiver);

        vm.prank(operator);
        arb.executeFlashloanBackrun(USDC, flash, bp);

        uint256 net = IERC20(USDC).balanceOf(profitReceiver) - before;
        emit log_named_decimal_uint("Motor3 backrun - lucro liquido pos-bribe (USDC)", net, 6);
        assertGt(net, 0, "backrun deveria fechar lucro liquido apos bribe + flashloan");
        assertEq(IERC20(USDC).balanceOf(address(arb)), 0, "contrato deve ficar limpo");
    }

    // ═══════════════ MOTOR 1 — Liquidation via flashloan ═══════════════
    function test_Fork_Motor1_Liquidation_Profits() public {
        address borrower = makeAddr("borrower");
        // 1) Borrower deposita 10 WETH de colateral e empresta USDC perto do limite
        uint256 collateral = 10 ether;
        deal(WETH, borrower, collateral);
        vm.startPrank(borrower);
        IERC20(WETH).approve(AAVE_V3_POOL, collateral);
        IAavePool(AAVE_V3_POOL).supply(WETH, collateral, borrower, 0);
        // empresta ~70% do permitido (deixa margem; depois derrubamos o preço)
        ( , , uint256 availBase, , , ) = IAavePool(AAVE_V3_POOL).getUserAccountData(borrower);
        // availBase é em "base currency" (USD 8 dec no Aave). Converte grosso pra USDC (6 dec).
        uint256 borrowUsdc = (availBase * 70 / 100) / 100; // base(8dec)→USDC(6dec) ≈ /100
        IAavePool(AAVE_V3_POOL).borrow(USDC, borrowUsdc, 2, 0, borrower);
        vm.stopPrank();

        // 2) "Quebra o preço": derruba o preço do WETH no oracle do Aave → HF < 1
        address provider = IAavePool(AAVE_V3_POOL).ADDRESSES_PROVIDER();
        address oracle = IAddressesProvider(provider).getPriceOracle();
        uint256 wethPrice = IAaveOracle(oracle).getAssetPrice(WETH);
        vm.mockCall(oracle, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(wethPrice / 2));

        ( , , , , , uint256 hf) = IAavePool(AAVE_V3_POOL).getUserAccountData(borrower);
        emit log_named_decimal_uint("HF do borrower apos drop", hf, 18);
        assertLt(hf, 1e18, "borrower deveria estar liquidavel (HF<1)");

        // 3) Liquida via flashloan: cobre parte da divida, recebe WETH com bonus, swap WETH→USDC, lucra
        uint256 debtToCover = borrowUsdc / 2; // closeFactor permite ate 50%
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({ router: SWAP_ROUTER_V3, tokenIn: WETH, tokenOut: USDC, amountIn: 0, minAmountOut: 0, dexType: DexType.UniswapV3, extraData: abi.encode(uint24(500)) });

        LiquidationParams memory p = LiquidationParams({
            user: borrower, collateralAsset: WETH, debtAsset: USDC, debtToCover: debtToCover,
            swapSteps: steps, minProfitWei: 1, profitReceiver: profitReceiver, flashSource: FlashSource.Aave
        });
        uint256 before = IERC20(USDC).balanceOf(profitReceiver);

        vm.prank(operator);
        liq.executeLiquidation(p);

        uint256 profit = IERC20(USDC).balanceOf(profitReceiver) - before;
        emit log_named_decimal_uint("Motor1 liquidacao - lucro liquido (USDC)", profit, 6);
        assertGt(profit, 0, "liquidacao deveria fechar lucro (bonus > premium + swap)");
    }
}
