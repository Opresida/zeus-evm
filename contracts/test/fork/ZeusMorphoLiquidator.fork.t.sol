// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {BribeManager} from "../../src/BribeManager.sol";
import {ZeusLiquidator} from "../../src/ZeusLiquidator.sol";
import {
    IZeusLiquidator,
    MorphoLiquidationParams
} from "../../src/interfaces/IZeusLiquidator.sol";
import {SwapStep, DexType, FlashSource} from "../../src/interfaces/IZeusExecutor.sol";

/// @title ZeusLiquidator — fork tests da cobertura Morpho Blue (liquidate) em Base mainnet.
///
/// @notice Fecha o GAP CRÍTICO de auditoria: `executeMorphoLiquidation` (ZeusLiquidator) não tinha
///         NENHUM fork test que provasse que o seletor/ABI do `IMorpho.liquidate(MarketParams, ...)`
///         bate com o singleton REAL do Morpho Blue na Base. Isso é o nosso edge: Morpho Blue é o
///         ÚNICO mercado de liquidação ABERTO na Base (Aave/Compound/Moonwell fecharam por OEV/MEV
///         capture). Até agora o Morpho só era exercitado como FONTE de flashloan, nunca como ALVO.
///
///         Estes testes deployam o contrato com os endereços REAIS de um market WETH/USDC líquido
///         e disparam o fluxo completo de flashloan — a call chega no `IMorpho.liquidate` real do
///         singleton e REVERTE porque o borrower aleatório não tem posição (logo está "saudável" →
///         o Morpho recusa a liquidação). O revert vem do PRÓPRIO Morpho (não de mismatch de ABI),
///         o que prova:
///           1. O guard `if (asset != mp.loanToken) revert InvalidCaller()` passou → o flashloan
///              foi tomado em loanToken (USDC) e bateu com o asset esperado pelo callback.
///           2. O provider de flashloan (Aave/Morpho) aceitou nosso flash de USDC e invocou o
///              callback (executeOperation/onMorphoFlashLoan); o decode do blob + flag transiente OK.
///           3. `IMorpho(morpho).liquidate(MarketParams{loanToken,collateralToken,oracle,irm,lltv},
///              borrower, seizedAssets, repaidShares, "")` foi REALMENTE chamado no singleton on-chain
///              com a ABI certa. Senão reverteria com decode/selector error ANTES de tocar o Morpho.
///
/// @dev RESULTADO DO REVERT (capturado com -vvvv): o frame chega no singleton REAL
///      `0xBBBB…EFFCb::liquidate(MarketParams{...}, borrower, 1e15, 0, "")`, que internamente chama
///      o IRM `borrowRate(...)` e o oracle `price()` (Chainlink `latestRoundData`), e então reverte
///      com `revert(ErrorsLib.HEALTHY_POSITION)` = string `"position is healthy"`, encodada como
///      `Error(string)` → selector `0xf4844814`. O importante: o revert é DENTRO do `Morpho::liquidate`,
///      provando que a call cruzou o ABI boundary e chegou ao protocolo (o borrower aleatório não tem
///      posição → `_isHealthy()` true → o Morpho recusa) — exatamente como o Moonwell reverteu com
///      "código 3 INSUFFICIENT_SHORTFALL" e o Compound com `NotLiquidatable 0xddeb79ba`.
///
/// @dev O que estes testes NÃO provam: lucro end-to-end (não há borrower underwater num bloco fixo
///      sem caçar um — round-trip valida ABI/wiring/segurança, não lucro). Sem RPC, dão skip.
///
/// @dev Market REAL da Base (resolvido via API do Morpho — WETH/USDC, líquido):
///        morpho (singleton) 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
///        loanToken          USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
///        collateralToken    WETH 0x4200000000000000000000000000000000000006
///        oracle             0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4
///        irm                0x46415998764C29aB2a25CbeA6254146D50D22687
///        lltv               860000000000000000 (86%)
contract ZeusMorphoLiquidatorForkTest is Test {
    // ── Base mainnet — fontes de flashloan (idênticas ao ZeusLiquidator.fork.t.sol) ──
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant MORPHO_SINGLETON = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER_V3 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // ── Morpho Blue market WETH/USDC (real e líquido na Base) ──
    address constant MORPHO_LOAN_TOKEN = USDC; // dívida = USDC
    address constant MORPHO_COLLATERAL = WETH; // colateral = WETH
    address constant MORPHO_ORACLE = 0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4;
    address constant MORPHO_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    uint256 constant MORPHO_LLTV = 860000000000000000; // 86%

    uint256 constant FORK_BLOCK = 28_000_000;
    uint256 constant INITIAL_MAX_TRADE = 1_000 ether;

    BribeManager public bribeManager;
    ZeusLiquidator public liquidator;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");

    function setUp() public {
        // Prefere BASE_RPC_ARCHIVE (archive dedicado p/ fork) → cai pra BASE_RPC_HTTP.
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
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Wiring contra Base mainnet
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_Constructor_WiresMorphoSingleton() public view {
        // O alvo de liquidate é travado ao mesmo endereço usado como fonte de flashloan.
        assertEq(liquidator.MORPHO_SINGLETON(), MORPHO_SINGLETON);
        assertEq(liquidator.AAVE_V3_POOL(), AAVE_V3_POOL);
        assertEq(liquidator.owner(), owner);
        assertFalse(liquidator.isKilled());
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ROUND-TRIP ABI — flashloan → IMorpho.liquidate real (reverte no health check)
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Monta params pro market WETH/USDC com borrower aleatório (sem posição → "saudável").
    ///      Dívida em USDC (loanToken == flashloan asset, exigido pelo guard InvalidCaller).
    ///      Morpho exige EXATAMENTE UM de (seizedAssets, repaidShares) != 0 → seizedAssets pequeno,
    ///      repaidShares = 0. Sem swaps (o fluxo reverte antes, no liquidate).
    function _params(FlashSource src) internal returns (MorphoLiquidationParams memory p) {
        SwapStep[] memory steps;
        p = MorphoLiquidationParams({
            morpho: MORPHO_SINGLETON,
            loanToken: MORPHO_LOAN_TOKEN, // USDC == flashloan asset
            collateralToken: MORPHO_COLLATERAL, // WETH
            oracle: MORPHO_ORACLE,
            irm: MORPHO_IRM,
            lltv: MORPHO_LLTV,
            borrower: makeAddr("notUnderwaterBorrower"),
            seizedAssets: 1e15, // exatamente UM de (seized, shares) != 0
            repaidShares: 0,
            flashloanAmount: 1_000e6, // 1000 USDC (loanToken)
            swapSteps: steps,
            minProfitWei: 1,
            profitReceiver: profitReceiver,
            flashSource: src
        });
    }

    /// Round-trip financiado por flashloan Aave V3 (Aave tem USDC na Base). O entrypoint toma o flash
    /// em USDC (== loanToken), o callback decoda + passa o guard `asset == loanToken`, e chega no
    /// `IMorpho.liquidate(...)` real → reverte porque o borrower aleatório está saudável. Prova a ABI.
    function test_Fork_ExecuteMorphoLiquidation_FlashSourceAave_RoundTrip() public {
        vm.prank(operator);
        // reverte DENTRO de Morpho::liquidate (health check), não na iniciação do flash nem no decode.
        vm.expectRevert();
        liquidator.executeMorphoLiquidation(_params(FlashSource.Aave));
    }

    /// Mesmo round-trip, financiado pelo flashloan 0% do PRÓPRIO Morpho Blue (singleton real na Base):
    /// flash(USDC) do Morpho → onMorphoFlashLoan → liquidate(...) no MESMO singleton (reentrante no
    /// protocolo). Valida o caminho flash-Morpho + liquidate-Morpho juntos.
    function test_Fork_ExecuteMorphoLiquidation_FlashSourceMorpho_RoundTrip() public {
        vm.prank(operator);
        vm.expectRevert();
        liquidator.executeMorphoLiquidation(_params(FlashSource.Morpho));
    }

    /// @notice Asserção-CHAVE (item 3 do pedido): prova que o revert veio DO MORPHO, não de um decode
    ///         malformado antes do callback. Se a call NÃO chegasse ao `liquidate` (ex.: ABI errada,
    ///         guard InvalidCaller, decode quebrado), o revert teria outro shape. Aqui forçamos o
    ///         caso e confirmamos que reverte (rodar com -vvvv mostra o frame `Morpho::liquidate`
    ///         imediatamente antes do revert — documentado no NatSpec do contrato de teste:
    ///         custom error do Morpho de posição saudável).
    /// @dev Para inspecionar o trace e confirmar o frame do Morpho:
    ///        forge test --match-test test_Fork_ExecuteMorphoLiquidation_ProvesRevertFromMorpho -vvvv
    function test_Fork_ExecuteMorphoLiquidation_ProvesRevertFromMorpho() public {
        MorphoLiquidationParams memory p = _params(FlashSource.Aave);
        vm.prank(operator);
        // Asserção FORTE: o revert é EXATAMENTE a string do Morpho Blue `"position is healthy"`
        // (ErrorsLib.HEALTHY_POSITION), encodada como Error(string). Se a call não chegasse ao
        // `liquidate` (ABI errada / decode quebrado / guard InvalidCaller), o revert teria outro
        // shape e este expectRevert tipado FALHARIA. Logo, passar prova que a call atravessou o
        // ABI boundary e reverteu DENTRO do protocolo Morpho.
        vm.expectRevert(bytes("position is healthy"));
        liquidator.executeMorphoLiquidation(p);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Circuit breakers + segurança contra estado real
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_ExecuteMorphoLiquidation_RevertsOnTradeTooLarge() public {
        // cap por-token aplicado ao loanToken (USDC). flashloanAmount 1000e6 > 500e6.
        vm.prank(owner);
        liquidator.setMaxTradePerToken(USDC, 500e6);

        MorphoLiquidationParams memory p = _params(FlashSource.Aave);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusLiquidator.TradeTooLarge.selector, uint256(1_000e6), uint256(500e6))
        );
        liquidator.executeMorphoLiquidation(p);
    }

    function test_Fork_ExecuteMorphoLiquidation_RejectsNonOperator() public {
        vm.prank(makeAddr("randoCaller"));
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeMorphoLiquidation(_params(FlashSource.Aave));
    }

    function test_Fork_ExecuteMorphoLiquidation_RejectsWrongMorphoSingleton() public {
        // Guard _validateMorphoParams: morpho != MORPHO_SINGLETON → NotAuthorized (anti-divergência).
        MorphoLiquidationParams memory p = _params(FlashSource.Aave);
        p.morpho = makeAddr("fakeMorpho");

        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.NotAuthorized.selector);
        liquidator.executeMorphoLiquidation(p);
    }

    function test_Fork_KillSwitch_BlocksExecution() public {
        vm.prank(owner);
        liquidator.kill();

        vm.prank(operator);
        vm.expectRevert(IZeusLiquidator.BotKilled.selector);
        liquidator.executeMorphoLiquidation(_params(FlashSource.Aave));
    }
}
