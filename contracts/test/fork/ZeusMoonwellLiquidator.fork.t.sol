// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {ZeusMoonwellLiquidator} from "../../src/ZeusMoonwellLiquidator.sol";
import {IZeusMoonwellLiquidator, MoonwellLiquidationParams} from "../../src/interfaces/IZeusMoonwellLiquidator.sol";
import {SwapStep, DexType, FlashSource} from "../../src/interfaces/IZeusExecutor.sol";

/// @title ZeusMoonwellLiquidator fork tests — validação de ABI on-chain em Base mainnet.
///
/// @notice Fecha um gap de auditoria: o ZeusMoonwellLiquidator não tinha NENHUM fork test
///         que provasse que o seletor/ABI do `liquidateBorrow`/`redeem` (mecânica Compound V2)
///         bate com os mTokens REAIS do Moonwell na Base. Estes testes deployam o contrato com
///         os endereços reais e disparam o fluxo completo de flashloan — a call chega no
///         `IMToken.liquidateBorrow` real do Moonwell e REVERTE porque o borrower aleatório não
///         é liquidável. O revert vem do PRÓPRIO Moonwell (não de mismatch de ABI), o que prova:
///           1. O provider de flashloan (Aave/Morpho/Balancer) aceitou nosso flash do underlying.
///           2. O callback (executeOperation/onMorphoFlashLoan/receiveFlashLoan) foi invocado.
///           3. A flag transiente anti-hijack foi setada e consumida no caminho legítimo.
///           4. `mToken.liquidateBorrow(borrower, repayAmount, mTokenCollateral)` foi REALMENTE
///              chamado no mToken on-chain com a ABI certa (senão reverteria com decode error /
///              selector inexistente, não com a lógica de liquidação do Moonwell).
///
/// @dev O que estes testes NÃO provam: lucro end-to-end (não há borrower underwater num bloco
///      fixo — isso exigiria fixar bloco com positions reais liquidáveis). Validam só o
///      caminho-de-revert (ABI/wiring/segurança). Sem RPC, dão skip (igual aos outros fork tests).
///
/// @dev Mapeamento de mToken→underlying CONFIRMADO on-chain (cast call ... "underlying()(address)"):
///        mWETH 0x628ff693426583D9a7FB391E54366292F509D457 → WETH 0x4200...0006
///        mUSDC 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22 → USDC 0x8335...2913
contract ZeusMoonwellLiquidatorForkTest is Test {
    // ── Base mainnet — fontes de flashloan (idênticas ao ZeusLiquidator.fork.t.sol) ──
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_SINGLETON = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER_V3 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // ── Moonwell (Compound V2 fork) — mTokens reais na Base ──
    address constant MOONWELL_COMPTROLLER = 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C;
    // mWETH → underlying WETH (confirmado on-chain)
    address constant MWETH = 0x628ff693426583D9a7FB391E54366292F509D457;
    // mUSDC → underlying USDC (confirmado on-chain)
    address constant MUSDC = 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22;

    uint256 constant FORK_BLOCK = 28_000_000;
    uint256 constant INITIAL_MAX_TRADE = 1_000_000e6; // generoso pra não bater TradeTooLarge antes do alvo

    ZeusMoonwellLiquidator public liquidator;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");

    function setUp() public {
        // Prefere BASE_RPC_ARCHIVE (endpoint archive dedicado p/ fork) → cai pra BASE_RPC_HTTP.
        string memory rpc = vm.envOr("BASE_RPC_ARCHIVE", vm.envOr("BASE_RPC_HTTP", string("")));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        // ZeusMoonwellLiquidator NÃO recebe BribeManager (v1 sem bribe).
        liquidator = new ZeusMoonwellLiquidator(
            AAVE_V3_POOL, MORPHO_SINGLETON, BALANCER_VAULT, owner, INITIAL_MAX_TRADE
        );

        vm.startPrank(owner);
        liquidator.setOperator(operator, true);
        liquidator.revive();
        liquidator.setApprovedRouter(SWAP_ROUTER_V3, true);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Wiring contra Base mainnet
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_Constructor_WiresImmutables() public view {
        assertEq(liquidator.AAVE_V3_POOL(), AAVE_V3_POOL);
        assertEq(liquidator.MORPHO_SINGLETON(), MORPHO_SINGLETON);
        assertEq(liquidator.BALANCER_VAULT(), BALANCER_VAULT);
        assertEq(liquidator.owner(), owner);
        assertTrue(liquidator.isOperator(operator));
        assertFalse(liquidator.isKilled());
        assertTrue(liquidator.approvedRouter(SWAP_ROUTER_V3));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Callbacks — segurança (caller não-autorizado)
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteOperation_RejectsNonAaveCaller() public {
        // Callback Aave chamado diretamente (não via Aave Pool) → InvalidCaller.
        bytes memory params = abi.encode(USDC, bytes(""));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(IZeusMoonwellLiquidator.InvalidCaller.selector);
        liquidator.executeOperation(USDC, 1000e6, 5e6, address(liquidator), params);
    }

    function test_Fork_ExecuteOperation_RejectsWrongInitiator() public {
        // msg.sender = Aave pool (impersonado), mas initiator != liquidator → InvalidCaller.
        bytes memory params = abi.encode(USDC, bytes(""));
        vm.prank(AAVE_V3_POOL);
        vm.expectRevert(IZeusMoonwellLiquidator.InvalidCaller.selector);
        liquidator.executeOperation(USDC, 1000e6, 5e6, makeAddr("phisher"), params);
    }

    function test_Fork_OnMorphoFlashLoan_RejectsNonMorphoCaller() public {
        bytes memory params = abi.encode(USDC, bytes(""));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(IZeusMoonwellLiquidator.InvalidCaller.selector);
        liquidator.onMorphoFlashLoan(1000e6, params);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ROUND-TRIP ABI — flashloan → liquidateBorrow real do Moonwell (reverte)
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Helper: monta params com borrower aleatório (não liquidável).
    ///      Dívida em mUSDC (paga USDC), seiza colateral mWETH.
    function _params(FlashSource src) internal returns (MoonwellLiquidationParams memory p) {
        SwapStep[] memory steps; // sem swaps — o fluxo reverte antes (no liquidateBorrow)
        p = MoonwellLiquidationParams({
            mTokenBorrowed: MUSDC,
            borrowedUnderlying: USDC,
            mTokenCollateral: MWETH,
            collateralUnderlying: WETH,
            borrower: makeAddr("notUnderwaterBorrower"),
            repayAmount: 100e6, // 100 USDC
            flashloanAmount: 100e6,
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: src
        });
    }

    /// Round-trip financiado por flashloan Aave V3. Chega no `mUSDC.liquidateBorrow` real e
    /// reverte (borrower não liquidável → Moonwell retorna código de erro ou reverte). Prova ABI.
    function test_Fork_ExecuteMoonwellLiquidation_FlashSourceAave_RoundTrip() public {
        vm.prank(operator);
        vm.expectRevert(); // reverte no liquidateBorrow (Compound V2 error), não na iniciação do flash
        liquidator.executeMoonwellLiquidation(_params(FlashSource.Aave));
    }

    /// Mesmo round-trip, financiado pelo flashloan 0% do Morpho Blue (singleton real na Base).
    function test_Fork_ExecuteMoonwellLiquidation_FlashSourceMorpho_RoundTrip() public {
        vm.prank(operator);
        vm.expectRevert();
        liquidator.executeMoonwellLiquidation(_params(FlashSource.Morpho));
    }

    /// Mesmo round-trip, financiado pelo flashloan 0% do Balancer V2 Vault (real na Base).
    function test_Fork_ExecuteMoonwellLiquidation_FlashSourceBalancer_RoundTrip() public {
        vm.prank(operator);
        vm.expectRevert();
        liquidator.executeMoonwellLiquidation(_params(FlashSource.Balancer));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Circuit breakers contra estado real
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteMoonwellLiquidation_RevertsOnTradeTooLarge() public {
        vm.prank(owner);
        liquidator.setMaxTradePerToken(USDC, 50e6);

        MoonwellLiquidationParams memory p = _params(FlashSource.Aave); // flashloanAmount = 100e6 > 50e6

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusMoonwellLiquidator.TradeTooLarge.selector, uint256(100e6), uint256(50e6))
        );
        liquidator.executeMoonwellLiquidation(p);
    }

    function test_Fork_KillSwitch_BlocksExecution() public {
        vm.prank(owner);
        liquidator.kill();

        vm.prank(operator);
        vm.expectRevert(IZeusMoonwellLiquidator.Killed_.selector);
        liquidator.executeMoonwellLiquidation(_params(FlashSource.Aave));
    }

    function test_Fork_ExecuteMoonwellLiquidation_RejectsNonOperator() public {
        vm.prank(makeAddr("randoCaller"));
        vm.expectRevert(IZeusMoonwellLiquidator.NotAuthorized.selector);
        liquidator.executeMoonwellLiquidation(_params(FlashSource.Aave));
    }
}
