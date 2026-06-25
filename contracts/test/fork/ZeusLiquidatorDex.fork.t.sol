// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BribeManager} from "../../src/BribeManager.sol";
import {ZeusLiquidator} from "../../src/ZeusLiquidator.sol";
import {SwapStep, DexType} from "../../src/interfaces/IZeusExecutor.sol";

/// @title ZeusLiquidator — fork test do `_executeSwaps` multi-DEX (Slipstream + Aerodrome) na Base.
///
/// @notice CONTEXTO: o `_executeSwaps` do ZeusLiquidator ganhou o branch `DexType.Slipstream` (multi-DEX
///         no Motor 1). A SlipstreamLib já é provada pelo `ZeusArbExecutorDex.fork` (o ArbExecutor usa a
///         MESMA lib) e o dispatch do liquidator é cópia idêntica — risco baixo. Este teste fecha 100%
///         exercitando o swap DENTRO do ZeusLiquidator contra os routers REAIS da Base.
///
///         PROBLEMA: `_executeSwaps` é `internal` e só é alcançado dentro de uma liquidação completa
///         (precisa de um borrower underwater — impossível em bloco fixo; os fork tests de liquidação
///         revertem ANTES do swap). SOLUÇÃO: um harness que expõe o `_executeSwaps` interno.
///
///         O QUE PROVA: o dispatch DexType (Slipstream/Aerodrome), o decode do `extraData`, a execução
///         do swap contra os routers reais, e a whitelist on-chain de routers (default-deny). NÃO prova
///         lucro de liquidação end-to-end (igual aos demais fork tests do liquidator).
contract ZeusLiquidatorHarness is ZeusLiquidator {
    constructor(
        address pool,
        address morpho,
        address balancer,
        address bribe,
        address owner_,
        uint256 maxTrade
    ) ZeusLiquidator(pool, morpho, balancer, bribe, owner_, maxTrade) {}

    /// @dev Expõe o `_executeSwaps` interno pra exercitar o dispatch multi-DEX contra a chain real.
    function execSwapsExposed(SwapStep[] memory steps) external {
        _executeSwaps(steps);
    }
}

contract ZeusLiquidatorDexForkTest is Test {
    // ─── Base mainnet ───
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_SINGLETON = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Aerodrome Slipstream (CL) SwapRouter + tickSpacing do pool WETH/USDC volatile.
    address constant SLIPSTREAM_SWAP_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    int24 constant SLIP_WETH_USDC_TICK_SPACING = 100;
    // Aerodrome (UniV2-style ve(3,3)) router + factory.
    address constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    uint256 constant FORK_BLOCK = 28_000_000;
    uint256 constant INITIAL_MAX_TRADE = 1_000 ether;
    uint256 constant USDC_IN = 1_000e6; // 1000 USDC

    BribeManager public bribeManager;
    ZeusLiquidatorHarness public harness;
    address public owner = makeAddr("owner");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_ARCHIVE", vm.envOr("BASE_RPC_HTTP", string("")));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        bribeManager = new BribeManager();
        harness = new ZeusLiquidatorHarness(
            AAVE_V3_POOL, MORPHO_SINGLETON, BALANCER_VAULT, address(bribeManager), owner, INITIAL_MAX_TRADE
        );

        vm.startPrank(owner);
        harness.revive();
        harness.setApprovedRouter(SLIPSTREAM_SWAP_ROUTER, true);
        harness.setApprovedRouter(AERODROME_ROUTER, true);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Swap Slipstream (Aerodrome CL) — DexType.Slipstream contra o router real
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecSwaps_Slipstream_UsdcToWeth() public {
        deal(USDC, address(harness), USDC_IN);

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SLIPSTREAM_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: USDC_IN,
            minAmountOut: 0,
            dexType: DexType.Slipstream,
            extraData: abi.encode(SLIP_WETH_USDC_TICK_SPACING)
        });

        harness.execSwapsExposed(steps);

        assertGt(IERC20(WETH).balanceOf(address(harness)), 0, "Slipstream swap nao rendeu WETH no liquidator");
        assertEq(IERC20(USDC).balanceOf(address(harness)), 0, "USDC deveria ter sido consumido no swap");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Swap Aerodrome (volatile) — DexType.Aerodrome contra o router real
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecSwaps_Aerodrome_UsdcToWeth() public {
        deal(USDC, address(harness), USDC_IN);

        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: AERODROME_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: USDC_IN,
            minAmountOut: 0,
            dexType: DexType.Aerodrome,
            extraData: abi.encode(false, AERODROME_FACTORY) // (bool isStable=false, address factory)
        });

        harness.execSwapsExposed(steps);

        assertGt(IERC20(WETH).balanceOf(address(harness)), 0, "Aerodrome swap nao rendeu WETH no liquidator");
        assertEq(IERC20(USDC).balanceOf(address(harness)), 0, "USDC deveria ter sido consumido no swap");
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Whitelist on-chain — router não aprovado reverte (default-deny)
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecSwaps_RevertsOnUnapprovedRouter() public {
        // Harness FRESH sem aprovar nenhum router → o _executeSwaps deve barrar antes do swap.
        ZeusLiquidatorHarness fresh = new ZeusLiquidatorHarness(
            AAVE_V3_POOL, MORPHO_SINGLETON, BALANCER_VAULT, address(bribeManager), owner, INITIAL_MAX_TRADE
        );
        vm.prank(owner);
        fresh.revive();

        deal(USDC, address(fresh), USDC_IN);
        SwapStep[] memory steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SLIPSTREAM_SWAP_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: USDC_IN,
            minAmountOut: 0,
            dexType: DexType.Slipstream,
            extraData: abi.encode(SLIP_WETH_USDC_TICK_SPACING)
        });

        vm.expectRevert(abi.encodeWithSelector(ZeusLiquidator.RouterNotApproved.selector, SLIPSTREAM_SWAP_ROUTER));
        fresh.execSwapsExposed(steps);
    }
}
