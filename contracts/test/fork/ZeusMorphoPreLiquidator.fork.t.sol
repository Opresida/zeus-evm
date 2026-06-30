// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ZeusMorphoPreLiquidator} from "../../src/ZeusMorphoPreLiquidator.sol";
import {PreMorphoLiquidationParams} from "../../src/interfaces/IZeusMorphoPreLiquidator.sol";
import {SwapStep, DexType} from "../../src/interfaces/IZeusExecutor.sol";

interface IMorphoLike {
    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function market(bytes32 id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );
}

interface IOracle {
    function price() external view returns (uint256);
}

/// @title ZeusMorphoPreLiquidator fork tests — contra a Base mainnet (mercado cbBTC/USDC real).
///
/// @notice Dois níveis de prova:
///   1. WIRING: a chamada chega no contrato PreLiquidation REAL (`0xa7272afc…`) e reverte com o erro do
///      próprio protocolo (`NotPreLiquidatablePosition`) quando a posição está saudável — prova ABI/params/
///      whitelist/flag-transiente corretos contra o contrato real.
///   2. E2E COMPLETO: mockando o oráculo (preço COMPUTADO da posição real pra cair na faixa pré-liquidável
///      0.8326–0.86 LLTV), roda `preLiquidate → onPreLiquidate → swap Slipstream → repay` e prova lucro em
///      stablecoin + zero resíduo de colateral. (Padrão dos fork tests de liquidação: força o cenário.)
///      ⚠️ O lucro é levemente inflado pelo mock (oráculo < DEX real); o número honesto vem do DRY_RUN.
contract ZeusMorphoPreLiquidatorForkTest is Test {
    address constant PRE_LIQUIDATION = 0xa7272aFc21f9C321024ED93892a1abfeb621C374; // cbBTC/USDC
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant ORACLE = 0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant SLIPSTREAM_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address constant BORROWER = 0xaEC4EE9A108304fCc5Cdc323d8A2A1D331C342b7;
    bytes32 constant MARKET_ID = 0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836;

    int24 constant TICK_SPACING = 1; // pool cbBTC/USDC Slipstream
    uint256 constant FORK_BLOCK = 46_765_960; // bloco em que o devedor estava em grind
    uint256 constant INITIAL_MAX_TRADE = 1_000 ether;

    ZeusMorphoPreLiquidator public liq;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_HTTP", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        liq = new ZeusMorphoPreLiquidator(owner, INITIAL_MAX_TRADE);
        vm.startPrank(owner);
        liq.revive();
        liq.setOperator(operator, true);
        liq.setApprovedPreLiquidation(PRE_LIQUIDATION, true);
        liq.setApprovedRouter(SLIPSTREAM_ROUTER, true);
        vm.stopPrank();
    }

    function _swap() internal pure returns (SwapStep[] memory steps) {
        steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: SLIPSTREAM_ROUTER,
            tokenIn: CBBTC,
            tokenOut: USDC,
            amountIn: 0,
            minAmountOut: 0,
            dexType: DexType.Slipstream,
            extraData: abi.encode(TICK_SPACING)
        });
    }

    // ─── 1. WIRING: chega no contrato real e reverte com o erro do protocolo ───

    function test_Fork_Wiring_ReachesRealPreLiquidation() public {
        PreMorphoLiquidationParams memory p;
        p.preLiquidation = PRE_LIQUIDATION;
        p.loanToken = USDC;
        p.collateralToken = CBBTC;
        p.borrower = BORROWER;
        p.seizedAssets = 50_000;
        p.repaidShares = 0;
        p.swapSteps = _swap();
        p.minProfitWei = 1;
        p.profitReceiver = profitReceiver;

        // Sem mock a posição está saudável no fim do bloco → o contrato REAL reverte com o seu próprio erro.
        // Prova que nossa chamada/ABI/params chegam certos no PreLiquidation real.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSignature("NotPreLiquidatablePosition()"));
        liq.executePreMorphoLiquidation(p);
    }

    function test_Fork_RevertsIfPreLiquidationNotApproved() public {
        vm.prank(owner);
        liq.setApprovedPreLiquidation(PRE_LIQUIDATION, false);
        PreMorphoLiquidationParams memory p;
        p.preLiquidation = PRE_LIQUIDATION;
        p.loanToken = USDC;
        p.collateralToken = CBBTC;
        p.borrower = BORROWER;
        p.swapSteps = _swap();
        p.profitReceiver = profitReceiver;
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSignature("NotApprovedPreLiquidation(address)", PRE_LIQUIDATION));
        liq.executePreMorphoLiquidation(p);
    }

    // ─── 2. E2E completo via mock do oráculo (preço computado da posição real) ───

    function test_Fork_E2E_RoundTripProfits() public {
        // Lê a posição real e computa o preço que coloca a LTV em 0.84 (faixa pré-liquidável: 0.8326–0.86).
        (, uint128 borrowShares, uint128 collateral) = IMorphoLike(MORPHO).position(MARKET_ID, BORROWER);
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = IMorphoLike(MORPHO).market(MARKET_ID);
        // borrowed = toAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares)
        uint256 borrowed = (uint256(borrowShares) * totalBorrowAssets + (totalBorrowShares - 1)) / totalBorrowShares;
        // LTV_wad = borrowed * 1e54 / (collateral * price)  ⇒  price = borrowed * 1e54 / (collateral * targetLtv)
        uint256 targetLtv = 0.84e18;
        uint256 priceMock = (borrowed * 1e54) / (uint256(collateral) * targetLtv);
        vm.mockCall(ORACLE, abi.encodeWithSelector(IOracle.price.selector), abi.encode(priceMock));

        // Fecha ~3% da dívida (dentro do close factor em LTV 0.84). Modo por-shares.
        PreMorphoLiquidationParams memory p;
        p.preLiquidation = PRE_LIQUIDATION;
        p.loanToken = USDC;
        p.collateralToken = CBBTC;
        p.borrower = BORROWER;
        p.seizedAssets = 0;
        p.repaidShares = (uint256(borrowShares) * 3) / 100;
        p.swapSteps = _swap();
        p.minProfitWei = 1;
        p.profitReceiver = profitReceiver;

        uint256 before = IERC20(USDC).balanceOf(profitReceiver);
        vm.prank(operator);
        liq.executePreMorphoLiquidation(p);
        uint256 profit = IERC20(USDC).balanceOf(profitReceiver) - before;

        emit log_named_decimal_uint("lucro USDC (inflado pelo mock)", profit, 6);
        assertGt(profit, 0, "deve lucrar em USDC (stable)");
        assertEq(IERC20(CBBTC).balanceOf(address(liq)), 0, "nao retem cbBTC");
        assertEq(IERC20(USDC).balanceOf(address(liq)), 0, "nao retem USDC");
    }
}
