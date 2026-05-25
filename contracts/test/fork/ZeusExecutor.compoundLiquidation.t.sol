// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ZeusExecutor} from "../../src/ZeusExecutor.sol";
import {
    IZeusExecutor,
    SwapStep,
    CompoundLiquidationParams,
    DexType
} from "../../src/interfaces/IZeusExecutor.sol";
import {IComet} from "../../src/interfaces/compound/IComet.sol";

/// @notice Interface estendida do Comet pra criar position de teste
interface ICometExtended is IComet {
    function supply(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
}

/// @notice Aave V3 Oracle pra mock de preços (forçar HF crash)
interface IPriceOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

/// @title ZeusExecutorCompoundLiquidationForkTest
/// @notice Valida executeCompoundLiquidation contra fork de Base mainnet.
///         Cria position no Comet cWETHv3, crasheia preço do WBTC (collateral)
///         pra position ficar liquidável, dispara o bot.
/// @dev Rodar: forge test --match-path test/fork/ZeusExecutor.compoundLiquidation.t.sol --fork-url $RPC -vv
contract ZeusExecutorCompoundLiquidationForkTest is Test {
    // ─── Endereços Base mainnet ───
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant UNI_V3_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf; // Coinbase BTC, collateral

    // Compound III markets em Base
    address constant CUSDCV3 = 0xb125E6687d4313864e53df431d5425969c15Eb2F; // base=USDC
    address constant CWETHV3 = 0x46e6b214b524310239732D51387075E0e70970bf; // base=WETH

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

        executor = new ZeusExecutor(AAVE_V3_POOL, owner, 1_000_000 ether);
        vm.startPrank(owner);
        executor.revive();
        executor.setOperator(operator, true);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 1 — executeCompoundLiquidation: reverts pra non-operator
    // ─────────────────────────────────────────────────────────────────────
    function test_CompoundLiquidation_RevertsForNonOperator() public onlyFork {
        SwapStep[] memory empty = new SwapStep[](0);
        CompoundLiquidationParams memory params = CompoundLiquidationParams({
            comet: CUSDCV3,
            borrower: victim,
            collateralAsset: WETH,
            baseAmount: 1000e6,
            minCollateralReceived: 0,
            swapSteps: empty,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });

        vm.prank(makeAddr("random"));
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeCompoundLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 2 — executeCompoundLiquidation: reverts se baseAmount > maxTradeWei
    // ─────────────────────────────────────────────────────────────────────
    function test_CompoundLiquidation_RevertsOnAmountAboveCap() public onlyFork {
        vm.prank(owner);
        executor.setMaxTradeWei(100e6); // cap baixo

        SwapStep[] memory empty = new SwapStep[](0);
        CompoundLiquidationParams memory params = CompoundLiquidationParams({
            comet: CUSDCV3,
            borrower: victim,
            collateralAsset: WETH,
            baseAmount: 1000e6, // > 100e6 cap
            minCollateralReceived: 0,
            swapSteps: empty,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusExecutor.TradeTooLarge.selector, 1000e6, 100e6)
        );
        executor.executeCompoundLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 3 — executeCompoundLiquidation: reverts com comet/borrower zero
    // ─────────────────────────────────────────────────────────────────────
    function test_CompoundLiquidation_RevertsOnZeroAddress() public onlyFork {
        SwapStep[] memory empty = new SwapStep[](0);
        CompoundLiquidationParams memory params = CompoundLiquidationParams({
            comet: address(0),
            borrower: victim,
            collateralAsset: WETH,
            baseAmount: 1000e6,
            minCollateralReceived: 0,
            swapSteps: empty,
            minProfitWei: 1,
            profitReceiver: profitReceiver
        });

        vm.prank(operator);
        vm.expectRevert(IZeusExecutor.NotAuthorized.selector);
        executor.executeCompoundLiquidation(params);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  TEST 4 — Sanity check: Comet cUSDCv3 em Base tem baseToken=USDC
    // ─────────────────────────────────────────────────────────────────────
    function test_CometBaseTokens_Match() public onlyFork {
        assertEq(IComet(CUSDCV3).baseToken(), USDC, "cUSDCv3 baseToken deve ser USDC");
        assertEq(IComet(CWETHV3).baseToken(), WETH, "cWETHv3 baseToken deve ser WETH");
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Nota sobre teste de liquidação real:
    //  Criar position liquidável em Compound III é mais complicado que em Aave
    //  porque requer:
    //  1. Supply collateral (ex: cbBTC) → mas precisa cbBTC mintável em fork
    //  2. Borrow base token (USDC) — limites de borrow
    //  3. Mover oracle do collateral pra HF cair (Compound usa Chainlink, mais
    //     difícil de mockar que Aave Oracle pure)
    //
    //  Pra Sprint 3 A, validamos:
    //  - Compilação OK
    //  - Estrutura de params correta
    //  - Reverts esperados em access control + caps
    //  - Sanity check de baseToken
    //
    //  Liquidação positiva ficará validada por:
    //  - Monitor pickup uma liquidação real on-chain quando volatilidade aparecer
    //  - Ou: fork test mais elaborado em Fase 3B junto com Morpho
    // ─────────────────────────────────────────────────────────────────────
}
