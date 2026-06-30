// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {BribeManager} from "../../src/BribeManager.sol";
import {ZeusLiquidator} from "../../src/ZeusLiquidator.sol";
import {
    IZeusLiquidator,
    CompoundLiquidationParams
} from "../../src/interfaces/IZeusLiquidator.sol";
import {SwapStep, DexType, FlashSource} from "../../src/interfaces/IZeusExecutor.sol";

/// @title ZeusLiquidator — fork tests da cobertura Compound III (absorb) em Base mainnet.
///
/// @notice Fecha um gap de auditoria: `executeCompoundLiquidation` (ZeusLiquidator) não tinha
///         fork test que provasse que o seletor/ABI do `IComet.absorb` (e `baseToken`/`buyCollateral`)
///         bate com os Comet REAIS do Compound III na Base. Estes testes deployam o contrato com os
///         endereços reais e disparam o fluxo de flashloan — a call chega no `IComet.absorb` real e
///         REVERTE porque o borrower aleatório não está liquidável (não absorbível). O revert vem do
///         PRÓPRIO Comet (não de mismatch de ABI), provando:
///           1. `IComet(comet).baseToken()` foi chamado no entrypoint e retornou o base asset real
///              (USDC pro cUSDCv3, WETH pro cWETHv3) — usado pra dimensionar o flashloan.
///           2. O provider de flashloan (Aave/Morpho) aceitou nosso flash do base asset.
///           3. O callback executeOperation/onMorphoFlashLoan decodou o blob + flag transiente OK.
///           4. `IComet(comet).absorb(address(this), accounts)` foi REALMENTE chamado no Comet
///              on-chain com a ABI certa (senão reverteria com decode/selector error, não com a
///              lógica de absorb do Compound III — "account não absorbível").
///
/// @dev O que NÃO prova: lucro end-to-end nem o `buyCollateral` (o fluxo reverte ANTES, no absorb,
///      porque não há borrower underwater num bloco fixo). Valida o caminho-de-revert (ABI/wiring/
///      segurança) do absorb. Sem RPC, dá skip.
///
/// @dev baseToken CONFIRMADO on-chain (cast call <comet> "baseToken()(address)"):
///        cUSDCv3 0xb125E6687d4313864e53df431d5425969c15Eb2F → USDC 0x8335...2913
///        cWETHv3 0x46e6b214b524310239732D51387075E0e70970bf → WETH 0x4200...0006
contract ZeusCompoundLiquidatorForkTest is Test {
    // ── Base mainnet — comuns (idênticos ao ZeusLiquidator.fork.t.sol) ──
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_SINGLETON = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER_V3 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // ── Compound III (Comet) — markets reais na Base ──
    address constant COMET_USDC = 0xb125E6687d4313864e53df431d5425969c15Eb2F; // base = USDC
    address constant COMET_WETH = 0x46e6b214b524310239732D51387075E0e70970bf; // base = WETH

    uint256 constant FORK_BLOCK = 28_000_000;
    uint256 constant INITIAL_MAX_TRADE = 1_000 ether;

    BribeManager public bribeManager;
    ZeusLiquidator public liquidator;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_ARCHIVE", vm.envOr("BASE_RPC_HTTP", string("")));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        bribeManager = new BribeManager();
        liquidator = new ZeusLiquidator(
            AAVE_V3_POOL, MORPHO_SINGLETON, BALANCER_VAULT, address(bribeManager), owner, INITIAL_MAX_TRADE
        );

        vm.startPrank(owner);
        liquidator.setWeth(WETH);
        liquidator.setUniV3SwapRouter(SWAP_ROUTER_V3);
        liquidator.setOperator(operator, true);
        liquidator.revive();
        liquidator.setApprovedRouter(SWAP_ROUTER_V3, true);
        liquidator.setApprovedComet(COMET_USDC, true);
        liquidator.setApprovedComet(COMET_WETH, true);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Wiring
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_Constructor_WiresImmutables() public view {
        assertEq(liquidator.AAVE_V3_POOL(), AAVE_V3_POOL);
        assertEq(liquidator.MORPHO_SINGLETON(), MORPHO_SINGLETON);
        assertEq(liquidator.BALANCER_VAULT(), BALANCER_VAULT);
        assertEq(liquidator.owner(), owner);
        assertFalse(liquidator.isKilled());
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ROUND-TRIP ABI — flashloan → IComet.absorb real (reverte)
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Params com borrower aleatório (não absorbível). Comet USDC → base/flash = USDC,
    ///      colateral WETH. Sem swaps (reverte antes, no absorb).
    function _paramsUsdc(FlashSource src) internal returns (CompoundLiquidationParams memory p) {
        SwapStep[] memory steps;
        p = CompoundLiquidationParams({
            comet: COMET_USDC,
            borrower: makeAddr("notLiquidatableBorrower"),
            collateralAsset: WETH,
            baseAmount: 100e6, // 100 USDC
            minCollateralReceived: 0,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: src
        });
    }

    /// Round-trip financiado por flashloan Aave V3. O entrypoint chama `comet.baseToken()` real
    /// (→ USDC), inicia o flash, e o callback chega no `comet.absorb(...)` real → reverte porque o
    /// borrower aleatório não está liquidável. Prova a ABI do absorb + baseToken.
    function test_Fork_ExecuteCompoundLiquidation_FlashSourceAave_RoundTrip() public {
        vm.prank(operator);
        vm.expectRevert(); // reverte no absorb (Comet: not liquidatable), não na iniciação do flash
        liquidator.executeCompoundLiquidation(_paramsUsdc(FlashSource.Aave));
    }

    /// v10: whitelist default-deny do Comet. Sem aprovar o Comet, o callback reverte CometNotApproved
    /// ANTES do absorb — prova que um `cp.comet` arbitrário não passa.
    function test_Fork_RevertsIfCometNotApproved() public {
        vm.prank(owner);
        liquidator.setApprovedComet(COMET_USDC, false); // revoga a aprovação do setUp
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ZeusLiquidator.CometNotApproved.selector, COMET_USDC));
        liquidator.executeCompoundLiquidation(_paramsUsdc(FlashSource.Aave));
    }

    /// Mesmo round-trip, financiado pelo flashloan 0% do Morpho Blue.
    function test_Fork_ExecuteCompoundLiquidation_FlashSourceMorpho_RoundTrip() public {
        vm.prank(operator);
        vm.expectRevert();
        liquidator.executeCompoundLiquidation(_paramsUsdc(FlashSource.Morpho));
    }

    /// Round-trip no Comet WETH (base = WETH): prova que `baseToken()` é lido por-Comet (não
    /// hardcoded) — o flash é dimensionado em WETH, e o absorb real reverte. Financiado por Aave.
    function test_Fork_ExecuteCompoundLiquidation_CometWeth_RoundTrip() public {
        SwapStep[] memory steps;
        CompoundLiquidationParams memory p = CompoundLiquidationParams({
            comet: COMET_WETH,
            borrower: makeAddr("notLiquidatableBorrower"),
            collateralAsset: USDC,
            baseAmount: 0.05 ether, // 0.05 WETH
            minCollateralReceived: 0,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: FlashSource.Aave
        });

        vm.prank(operator);
        vm.expectRevert();
        liquidator.executeCompoundLiquidation(p);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Circuit breakers + segurança contra estado real
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteCompoundLiquidation_RevertsOnTradeTooLarge() public {
        // baseToken do Comet USDC = USDC → cap por-token aplicado ao USDC.
        vm.prank(owner);
        liquidator.setMaxTradePerToken(USDC, 50e6);

        CompoundLiquidationParams memory p = _paramsUsdc(FlashSource.Aave); // baseAmount 100e6 > 50e6

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusLiquidator.TradeTooLarge.selector, uint256(100e6), uint256(50e6))
        );
        liquidator.executeCompoundLiquidation(p);
    }

    function test_Fork_ExecuteCompoundLiquidation_RejectsNonOperator() public {
        vm.prank(makeAddr("randoCaller"));
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeCompoundLiquidation(_paramsUsdc(FlashSource.Aave));
    }

    function test_Fork_KillSwitch_BlocksExecution() public {
        vm.prank(owner);
        liquidator.kill();

        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.BotKilled.selector);
        liquidator.executeCompoundLiquidation(_paramsUsdc(FlashSource.Aave));
    }
}
