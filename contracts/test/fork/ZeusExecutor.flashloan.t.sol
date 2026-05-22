// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ZeusExecutor} from "../../src/ZeusExecutor.sol";
import {IZeusExecutor, SwapStep, ArbitrageParams, DexType} from "../../src/interfaces/IZeusExecutor.sol";
import {IPool} from "../../src/interfaces/aave/IPool.sol";

/// @title ZeusExecutorFlashloanForkTest — testes de flashloan Aave V3 contra Base mainnet
/// @notice Valida o callback `executeOperation`:
///         (1) Aave V3 Pool consegue emprestar e o callback recebe corretamente
///         (2) Repay é processado (approve + Aave puxa)
///         (3) Roundtrip lossy reverte (proteção de capital)
///         (4) Initiator validation funciona
/// @dev Rodar com:
///      forge test --match-path "test/fork/ZeusExecutor.flashloan.t.sol" --fork-url $BASE_RPC_HTTP -vv
contract ZeusExecutorFlashloanForkTest is Test {
    // ─── Endereços Base Mainnet ───
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant UNI_V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // Tokens
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint24 constant UNI_V3_FEE_005 = 500;

    ZeusExecutor public executor;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");

    /// @dev Skip automático se BASE_RPC_HTTP não definido
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
        } catch {
            return;
        }

        // Cap alto (10k USDC equivalente) pra permitir flashloans relevantes
        executor = new ZeusExecutor(AAVE_V3_POOL, owner, 10_000_000_000); // 10k USDC em wei (6 decimais)

        vm.startPrank(owner);
        executor.revive();
        executor.setOperator(operator, true);
        vm.stopPrank();
    }

    // ════════ TESTES ════════

    /// @notice Roundtrip lossy via flashloan deve reverter (proteção de capital)
    /// @dev Aave empresta 100 USDC. Executor faz USDC→WETH→USDC roundtrip
    ///      que perde ~0.1% pra fees. Não consegue cobrir os 100 + 0.05% premium.
    ///      → Reverte com InsufficientProfit OU FlashloanRepayShortfall.
    function test_Flashloan_LossyRoundtrip_Reverts() public onlyFork {
        uint256 flashloanAmount = 100_000_000; // 100 USDC

        SwapStep[] memory steps = new SwapStep[](2);
        // Step 1: USDC -> WETH (usa o saldo emprestado)
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: flashloanAmount,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });
        // Step 2: WETH -> USDC (volta)
        steps[1] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: 0, // usa saldo atual de WETH
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0, // mesmo aceitando 0 profit, roundtrip não cobre o premium
            profitToken: USDC,
            profitReceiver: address(executor)
        });

        vm.prank(operator);
        vm.expectRevert(); // InsufficientProfit ou FlashloanRepayShortfall
        executor.executeFlashloanArbitrage(USDC, flashloanAmount, params);
    }

    /// @notice Callback security: chamadas externas a executeOperation devem reverter
    /// @dev Cenário 1: chamada direta (não pelo Aave Pool) → revert InvalidCaller
    function test_ExecuteOperation_RevertsIfNotAavePool() public onlyFork {
        // Encoda params válidos
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 100_000_000,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        ArbitrageParams memory arbParams = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: USDC,
            profitReceiver: address(executor)
        });

        bytes memory encodedParams = abi.encode(arbParams, operator);

        // Tenta chamar executeOperation direto (não pelo Aave)
        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.InvalidCaller.selector);
        executor.executeOperation(USDC, 100_000_000, 50_000, address(executor), encodedParams);
    }

    /// @notice Callback security: initiator deve ser o contrato Executor (não outro)
    /// @dev Simula que Aave Pool chama mas com initiator falso
    ///      → revert InvalidCaller (defesa contra abuso do executor como flash receiver de terceiros)
    function test_ExecuteOperation_RevertsIfInitiatorIsExternal() public onlyFork {
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 100_000_000,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        ArbitrageParams memory arbParams = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: USDC,
            profitReceiver: address(executor)
        });

        bytes memory encodedParams = abi.encode(arbParams, operator);

        // Simula Aave Pool chamando mas com initiator falso
        vm.prank(AAVE_V3_POOL);
        vm.expectRevert(IZeusExecutor.InvalidCaller.selector);
        executor.executeOperation(
            USDC,
            100_000_000,
            50_000,
            makeAddr("attacker"), // initiator falso
            encodedParams
        );
    }

    /// @notice Acesso ao flashloan deve ser restrito a operator/owner
    function test_ExecuteFlashloanArbitrage_RevertsForNonOperator() public onlyFork {
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 100_000_000,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: USDC,
            profitReceiver: address(executor)
        });

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeFlashloanArbitrage(USDC, 100_000_000, params);
    }

    /// @notice Trade size cap enforced no entry point
    function test_ExecuteFlashloanArbitrage_RevertsOnAmountAboveCap() public onlyFork {
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: UNI_V3_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: 1_000_000,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(UNI_V3_FEE_005)
        });

        ArbitrageParams memory params = ArbitrageParams({
            steps: steps,
            minProfitWei: 0,
            profitToken: USDC,
            profitReceiver: address(executor)
        });

        // Tentar emprestar 100k USDC quando cap é 10k
        uint256 above = 100_000_000_000;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IZeusExecutor.TradeTooLarge.selector, above, 10_000_000_000));
        executor.executeFlashloanArbitrage(USDC, above, params);
    }
}
