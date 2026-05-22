// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ZeusExecutor} from "../../src/ZeusExecutor.sol";
import {IZeusExecutor, SwapStep, ArbitrageParams, DexType} from "../../src/interfaces/IZeusExecutor.sol";

/// @title ZeusExecutorForkTest — testes contra fork de Base mainnet
/// @notice Valida swaps reais contra DEXs em produção (Uniswap V3, Aerodrome)
///         sem gastar 1 wei real. Usa `vm.createFork` + `vm.deal`.
/// @dev Rodar com:
///      forge test --match-path test/fork/* --fork-url $BASE_RPC_HTTP -vv
contract ZeusExecutorForkTest is Test {
    // ─── Endereços Base Mainnet ───
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant UNI_V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // Tokens
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Uniswap V3 WETH/USDC fee tier 0.05% (pool com maior liquidez na Base)
    uint24 constant UNI_V3_FEE_005 = 500;

    ZeusExecutor public executor;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");

    /// @dev Roda apenas quando fork URL é fornecido. Senão, test é skipped.
    modifier onlyFork() {
        try vm.activeFork() returns (uint256) {
            _;
        } catch {
            console2.log("Skipping fork test - no active fork (use --fork-url $BASE_RPC_HTTP)");
            return;
        }
    }

    function setUp() public {
        // Tenta criar fork de Base mainnet a partir da env var.
        // Se BASE_RPC_HTTP não estiver definido, vm.createFork falha mas o try/catch no modifier skip
        try vm.envString("BASE_RPC_HTTP") returns (string memory rpc) {
            vm.createSelectFork(rpc);
        } catch {
            // Sem RPC — fork tests serão skipped via modifier
        }

        // Setup do executor (mesmo se fork falhar, contrato é deployed pra testes simples)
        executor = new ZeusExecutor(AAVE_V3_POOL, owner, 100 ether);
        vm.startPrank(owner);
        executor.revive();
        executor.setOperator(operator, true);
        vm.stopPrank();
    }

    /// @notice Valida que conseguimos ler o estado real da Base
    function test_ForkActive() public onlyFork {
        uint256 blockNumber = block.number;
        assertTrue(blockNumber > 40_000_000, "Block number should be high (Base mainnet)");
        console2.log("Base mainnet block:", blockNumber);
    }

    /// @notice Swap real: 1 WETH -> USDC via Uniswap V3 pool 0.05%
    /// @dev Usa vm.deal pra dar WETH ao executor (simula que o bot transferiu capital antes)
    function test_UniswapV3_Swap_WETH_to_USDC() public onlyFork {
        uint256 amountIn = 1 ether; // 1 WETH

        // Dá 1 WETH pro executor (simulando capital próprio depositado pelo bot)
        deal(WETH, address(executor), amountIn);
        assertEq(IERC20(WETH).balanceOf(address(executor)), amountIn, "WETH transferido");

        uint256 usdcBefore = IERC20(USDC).balanceOf(address(executor));

        // Monta SwapStep
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: amountIn,
            minAmountOut: 1000e6, // 1000 USDC minimo (ETH atual ~$2-4k, safe margin)
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0, // sem profit obrigatório nesse teste (só validamos o swap)
            profitToken: USDC,
            profitReceiver: address(executor) // mantém aqui pra inspecionar
        });

        // Executa
        vm.prank(operator);
        executor.executeArbitrage(params);

        uint256 usdcAfter = IERC20(USDC).balanceOf(address(executor));
        uint256 usdcReceived = usdcAfter - usdcBefore;

        console2.log("WETH in:    ", amountIn);
        console2.log("USDC out:   ", usdcReceived);
        console2.log("Price:      $", usdcReceived / 1e6, " per ETH");

        assertGt(usdcReceived, 1000e6, "Should receive > 1000 USDC");
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "All WETH spent");
    }

    /// @notice Multi-step funciona: WETH -> USDC -> WETH (mesma pool, perde pra fees = revert correto)
    /// @dev Valida que:
    ///      (1) multi-step executa em sequência
    ///      (2) `amountIn=0` no step 2 usa saldo atual (USDC do step 1)
    ///      (3) contrato PROTEGE capital — roundtrip perde 0.1% → reverte com InsufficientProfit
    function test_UniswapV3_Multistep_RevertsOnLossyRoundtrip() public onlyFork {
        uint256 amountIn = 1 ether;
        deal(WETH, address(executor), amountIn);

        SwapStep[] memory steps = new SwapStep[](2);
        // Step 1: 1 WETH -> USDC
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: amountIn,
            minAmountOut: 1000e6,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });
        // Step 2: USDC -> WETH (amountIn=0 = usa saldo atual do step 1)
        steps[1] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 0,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        // minProfitWei=0 mas roundtrip perde pra fees → contrato reverte protegendo capital
        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: WETH,
            profitReceiver: address(executor)
        });

        vm.prank(operator);
        vm.expectRevert(); // InsufficientProfit — comportamento esperado (proteção de capital)
        executor.executeArbitrage(params);
    }

    /// @notice Validar que minProfitWei reverte se não há profit
    function test_RevertsOn_InsufficientProfit_Roundtrip() public onlyFork {
        uint256 amountIn = 1 ether;
        deal(WETH, address(executor), amountIn);

        SwapStep[] memory steps = new SwapStep[](2);
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: amountIn,
            minAmountOut: 1000e6,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });
        steps[1] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 0,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        // Exige 0.01 ETH de profit (que não vai acontecer — roundtrip dá prejuízo)
        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0.01 ether,
            profitToken: WETH,
            profitReceiver: address(executor)
        });

        vm.prank(operator);
        vm.expectRevert(); // InsufficientProfit
        executor.executeArbitrage(params);
    }
}
