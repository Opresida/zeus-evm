// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ZeusExecutor} from "../../src/ZeusExecutor.sol";
import {IZeusExecutor, SwapStep, ArbitrageParams, DexType} from "../../src/interfaces/IZeusExecutor.sol";

/// @notice Interface mínima do Uniswap V3 SwapRouter02 (sem deadline)
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

/// @title ZeusExecutorProfitArbTest — fork tests do caminho POSITIVO (wallet + flashloan lucrativo)
/// @notice Não depende de gap natural em mainnet (que é raro). Cria gap artificial via
///         swap grande em UniV3, depois executa arb capturando esse gap.
///         Valida que:
///         1. executeArbitrage() funciona quando há profit (wallet arb)
///         2. executeFlashloanArbitrage() funciona com Aave (flashloan arb)
/// @dev Rodar: forge test --match-path test/fork/ZeusExecutor.profitArb.t.sol --fork-url $BASE_RPC_HTTP -vv
contract ZeusExecutorProfitArbTest is Test {
    // ─── Endereços Base Mainnet ───
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant UNI_V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;

    // Tokens Base
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // UniV3 fee tier 0.05% (pool com maior liquidez WETH/USDC Base)
    uint24 constant UNI_V3_FEE_005 = 500;

    ZeusExecutor public executor;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");

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

        // Deploy + ativa + autoriza operator
        executor = new ZeusExecutor(AAVE_V3_POOL, owner, 1_000_000 ether);
        vm.startPrank(owner);
        executor.revive();
        executor.setOperator(operator, true);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Helper: cria gap artificial dumping WETH em UniV3 pool 0.05%
    // ─────────────────────────────────────────────────────────────────────
    /// @dev Faz swap grande WETH→USDC em UniV3, deprimindo preço de WETH em UniV3
    ///      (USDC fica mais barato em UniV3 vs Aerodrome).
    ///      Após isso, comprar WETH em UniV3 (barato) e vender em Aerodrome (caro) deve lucrar.
    function _createPriceGap(uint256 wethDumpAmount) internal {
        address attacker = makeAddr("attacker");
        deal(WETH, attacker, wethDumpAmount);

        vm.startPrank(attacker);
        IERC20(WETH).approve(UNI_V3_SWAP_ROUTER, wethDumpAmount);
        uint256 usdcOut = ISwapRouter02(UNI_V3_SWAP_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: USDC,
                fee: UNI_V3_FEE_005,
                recipient: attacker,
                amountIn: wethDumpAmount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        console2.log("=== Gap artificial criado ===");
        console2.log("WETH dumped em UniV3:", wethDumpAmount / 1e18, "WETH");
        console2.log("USDC recebido pelo atacante:", usdcOut / 1e6);
    }

    /// @dev Constrói os SwapSteps pra arb: USDC -> WETH (UniV3 barato) -> USDC (Aerodrome caro)
    function _buildArbSteps(uint256 usdcIn) internal pure returns (SwapStep[] memory steps) {
        steps = new SwapStep[](2);
        // Step 1: USDC -> WETH em UniV3 (preço deprimido = mais WETH por USDC)
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: usdcIn,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });
        // Step 2: WETH -> USDC em Aerodrome volatile pool
        steps[1] = SwapStep({
            router: AERODROME_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: 0, // usa saldo de WETH do step 1
            minAmountOut: 0,
            dexType: DexType.Aerodrome,
            extraData: abi.encode(false, address(0)) // volatile, default factory
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 1 — Wallet arb LUCRATIVA (saldo próprio, sem flashloan)
    // ─────────────────────────────────────────────────────────────────────
    function test_WalletArb_GeneratesProfit_AfterPriceGap() public onlyFork {
        // ─── Cria gap GRANDE (pool 0.05% Base tem ~$50M TVL — precisa de movimento agressivo) ───
        _createPriceGap(2_000 ether); // 2.000 WETH dump (~$4M) — move preço ~3-4%

        // ─── Arb pequeno pra não fechar o gap de volta ───
        uint256 usdcIn = 5_000e6; // $5k USDC seed (10x menor que o gap criado)
        deal(USDC, address(executor), usdcIn);
        assertEq(IERC20(USDC).balanceOf(address(executor)), usdcIn);

        uint256 receiverBefore = IERC20(USDC).balanceOf(profitReceiver);

        // ─── Constrói params ───
        ArbitrageParams memory params = ArbitrageParams({
            steps: _buildArbSteps(usdcIn),
            minProfitWei: 1, // exige profit > 0
            profitToken: USDC,
            profitReceiver: profitReceiver
        });

        // ─── Executa ───
        vm.prank(operator);
        executor.executeArbitrage(params);

        // ─── Valida profit ───
        uint256 receiverAfter = IERC20(USDC).balanceOf(profitReceiver);
        uint256 profit = receiverAfter - receiverBefore;

        console2.log("=== Wallet Arb Result ===");
        console2.log("USDC seed:        ", usdcIn / 1e6);
        console2.log("Profit USDC raw:  ", profit);
        console2.log("Profit em $:      ", profit / 1e6);
        console2.log("Profit bps:       ", (profit * 10_000) / usdcIn);

        assertGt(profit, 0, "Wallet arb should generate profit after price gap");

        // Contrato fica zerado (profit foi pro receiver, capital inicial foi gasto no arb)
        // O capital inicial vira parte do "amountOut do step 2" — o profit é a diferença
        // O saldo no contrato deve ser ~ usdcIn (capital recuperado + algumas dust units)
        uint256 executorBalance = IERC20(USDC).balanceOf(address(executor));
        console2.log("Saldo executor pos-arb:", executorBalance / 1e6);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 2 — Flashloan arb LUCRATIVA (Aave V3 + repay + profit líquido)
    // ─────────────────────────────────────────────────────────────────────
    function test_FlashloanArb_GeneratesProfit_AfterPriceGap() public onlyFork {
        // ─── Cria gap GRANDE (pool 0.05% Base é profundo + Aave fee 0.05%) ───
        _createPriceGap(2_000 ether); // 2.000 WETH dump

        // ─── NÃO funda executor: Aave provê o capital ───
        assertEq(IERC20(USDC).balanceOf(address(executor)), 0, "executor deve estar zerado");

        uint256 flashAmount = 5_000e6; // $5k flashloan
        uint256 receiverBefore = IERC20(USDC).balanceOf(profitReceiver);

        ArbitrageParams memory params = ArbitrageParams({
            steps: _buildArbSteps(flashAmount),
            minProfitWei: 1, // qualquer profit > 0 após pagar Aave fee
            profitToken: USDC,
            profitReceiver: profitReceiver
        });

        // ─── Executa flashloan arb ───
        vm.prank(operator);
        executor.executeFlashloanArbitrage(USDC, flashAmount, params);

        // ─── Valida profit líquido (já descontou fee Aave) ───
        uint256 receiverAfter = IERC20(USDC).balanceOf(profitReceiver);
        uint256 netProfit = receiverAfter - receiverBefore;

        console2.log("=== Flashloan Arb Result ===");
        console2.log("Flashloan amount:    ", flashAmount / 1e6);
        console2.log("Net profit USDC raw: ", netProfit);
        console2.log("Net profit em $:     ", netProfit / 1e6);
        console2.log("Net profit bps:      ", (netProfit * 10_000) / flashAmount);

        assertGt(netProfit, 0, "Flashloan arb should generate net profit (after Aave fee)");
    }
}
