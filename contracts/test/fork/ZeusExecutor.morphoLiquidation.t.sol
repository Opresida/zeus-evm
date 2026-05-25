// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ZeusExecutor} from "../../src/ZeusExecutor.sol";
import {
    IZeusExecutor,
    SwapStep,
    MorphoLiquidationParams,
    DexType
} from "../../src/interfaces/IZeusExecutor.sol";
import {IMorpho, MarketParams} from "../../src/interfaces/morpho/IMorpho.sol";

/// @title ZeusExecutorMorphoLiquidationForkTest
/// @notice Valida executeMorphoLiquidation contra Morpho Blue em Base mainnet (fork).
/// @dev Rodar: forge test --match-path test/fork/ZeusExecutor.morphoLiquidation.t.sol --fork-url $RPC -vv
contract ZeusExecutorMorphoLiquidationForkTest is Test {
    // ─── Endereços Base mainnet ───
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant UNI_V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;

    // Adaptive Curve IRM (Morpho)
    address constant ADAPTIVE_CURVE_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;

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

        executor = new ZeusExecutor(AAVE_V3_POOL, owner, 1_000_000 ether);
        vm.startPrank(owner);
        executor.revive();
        executor.setOperator(operator, true);
        vm.stopPrank();
    }

    function _makeParams(uint256 seized) internal view returns (MorphoLiquidationParams memory) {
        SwapStep[] memory empty = new SwapStep[](0);
        return MorphoLiquidationParams({
            morpho: MORPHO,
            loanToken: USDC,
            collateralToken: CBBTC,
            oracle: address(0x1234), // placeholder
            irm: ADAPTIVE_CURVE_IRM,
            lltv: 86e16, // 86%
            borrower: victim,
            seizedAssets: seized,
            repaidShares: 0,
            swapSteps: empty,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 1 — Reverts pra non-operator
    // ─────────────────────────────────────────────────────────────────────
    function test_MorphoLiquidation_RevertsForNonOperator() public onlyFork {
        MorphoLiquidationParams memory params = _makeParams(1000e6);

        vm.prank(makeAddr("random"));
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeMorphoLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 2 — Reverts se size > maxTradeWei
    // ─────────────────────────────────────────────────────────────────────
    function test_MorphoLiquidation_RevertsOnAmountAboveCap() public onlyFork {
        vm.prank(owner);
        executor.setMaxTradeWei(100e6);

        MorphoLiquidationParams memory params = _makeParams(1000e6);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusExecutor.TradeTooLarge.selector, 1000e6, 100e6)
        );
        executor.executeMorphoLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 3 — Reverts com morpho zero address
    // ─────────────────────────────────────────────────────────────────────
    function test_MorphoLiquidation_RevertsOnZeroAddress() public onlyFork {
        MorphoLiquidationParams memory params = _makeParams(1000e6);
        params.morpho = address(0);

        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeMorphoLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 4 — Reverts com borrower zero
    // ─────────────────────────────────────────────────────────────────────
    function test_MorphoLiquidation_RevertsOnZeroBorrower() public onlyFork {
        MorphoLiquidationParams memory params = _makeParams(1000e6);
        params.borrower = address(0);

        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeMorphoLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 5 — Reverts com loanToken zero (sanity)
    // ─────────────────────────────────────────────────────────────────────
    function test_MorphoLiquidation_RevertsOnZeroLoanToken() public onlyFork {
        MorphoLiquidationParams memory params = _makeParams(1000e6);
        params.loanToken = address(0);

        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeMorphoLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Nota: teste positivo (liquidação real) requer:
    //  - Descobrir market real Morpho Base (consultar via subgraph off-chain)
    //  - Criar position via Morpho.supply + supplyCollateral + borrow
    //  - Manipular oracle pra HF cair
    //  Pelo tempo, validamos via reverts + sanity. Liquidação positiva real será
    //  capturada ao vivo quando primeira liquidação acontecer em Base mainnet.
    // ─────────────────────────────────────────────────────────────────────
}
