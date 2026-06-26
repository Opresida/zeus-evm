// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ZeusMorphoPreLiquidator} from "../src/ZeusMorphoPreLiquidator.sol";
import {IZeusMorphoPreLiquidator, PreMorphoLiquidationParams} from "../src/interfaces/IZeusMorphoPreLiquidator.sol";
import {IPreLiquidationCallback} from "../src/interfaces/morpho/IPreLiquidation.sol";
import {SwapStep, DexType} from "../src/interfaces/IZeusExecutor.sol";

/// @dev ERC20 mintável pros testes (loanToken stable).
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mock do contrato PreLiquidation. Simula o resultado de `preLiquidate` (sem callback): mint do
///      surplus de loanToken no liquidador (= lucro). Tem também um disparo direto do callback fora de
///      contexto (pra provar o guard da flag transiente).
contract MockPreLiquidation {
    MockERC20 public immutable LOAN;
    uint256 public surplus;

    constructor(MockERC20 loan) {
        LOAN = loan;
    }

    function setSurplus(uint256 s) external {
        surplus = s;
    }

    /// @notice Espelha a assinatura real; aqui só minta o surplus no caller (o liquidador).
    function preLiquidate(address, uint256, uint256, bytes calldata) external returns (uint256, uint256) {
        if (surplus > 0) LOAN.mint(msg.sender, surplus);
        return (0, 0);
    }

    /// @notice Tenta chamar o callback do liquidador FORA do fluxo de preLiquidate (deve reverter no guard).
    function pokeCallback(address target, uint256 repaidAssets, bytes calldata data) external {
        IPreLiquidationCallback(target).onPreLiquidate(repaidAssets, data);
    }
}

/// @title ZeusMorphoPreLiquidatorTest — adversariais (unit):
///   1. Constructor (owner + maxTrade + starts killed)
///   2. Auth (operator gate, kill switch)
///   3. Validação (whitelist default-deny, swapSteps obrigatório = sem inventário, zero-addrs)
///   4. Profit gate (InsufficientProfit) + happy accounting (surplus → profitReceiver)
///   5. Callback security (não-whitelisted + fora de contexto via flag transiente)
///   6. Admin (setOperator, setApprovedPreLiquidation, setMaxTrade, kill/revive — owner only)
contract ZeusMorphoPreLiquidatorTest is Test {
    ZeusMorphoPreLiquidator public liq;
    MockERC20 public loan;
    MockPreLiquidation public preLiq;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public unauthorized = makeAddr("unauthorized");
    address public profitReceiver = makeAddr("profitReceiver");

    address constant FAKE_COLLATERAL = address(0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf); // cbBTC
    address constant borrower = address(0xdEADbeEF00000000000000000000000000000001);
    uint256 public constant INITIAL_MAX_TRADE_WEI = 100 ether;

    function setUp() public {
        loan = new MockERC20();
        preLiq = new MockPreLiquidation(loan);
        liq = new ZeusMorphoPreLiquidator(owner, INITIAL_MAX_TRADE_WEI);
        vm.startPrank(owner);
        liq.revive();
        liq.setOperator(operator, true);
        liq.setApprovedPreLiquidation(address(preLiq), true);
        vm.stopPrank();
    }

    function _steps() internal view returns (SwapStep[] memory s) {
        s = new SwapStep[](1);
        s[0] = SwapStep({
            router: address(0x1234),
            tokenIn: FAKE_COLLATERAL,
            tokenOut: address(loan),
            amountIn: 0,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(uint24(500))
        });
    }

    function _params() internal view returns (PreMorphoLiquidationParams memory p) {
        p.preLiquidation = address(preLiq);
        p.loanToken = address(loan);
        p.collateralToken = FAKE_COLLATERAL;
        p.borrower = borrower;
        p.seizedAssets = 0;
        p.repaidShares = 1000e6;
        p.swapSteps = _steps();
        p.minProfitWei = 1;
        p.profitReceiver = profitReceiver;
    }

    // ─── Constructor ───

    function test_Constructor_SetsState() public view {
        assertEq(liq.owner(), owner);
        assertEq(liq.maxTradeWei(), INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_StartsKilled() public {
        ZeusMorphoPreLiquidator fresh = new ZeusMorphoPreLiquidator(owner, INITIAL_MAX_TRADE_WEI);
        assertTrue(fresh.isKilled());
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert();
        new ZeusMorphoPreLiquidator(address(0), INITIAL_MAX_TRADE_WEI);
    }

    // ─── Auth ───

    function test_Execute_RevertsIfNotOperator() public {
        vm.prank(unauthorized);
        vm.expectRevert(IZeusMorphoPreLiquidator.NotAuthorized.selector);
        liq.executePreMorphoLiquidation(_params());
    }

    function test_Execute_RevertsIfKilled() public {
        vm.prank(owner);
        liq.kill();
        vm.prank(operator);
        vm.expectRevert(IZeusMorphoPreLiquidator.BotKilled.selector);
        liq.executePreMorphoLiquidation(_params());
    }

    // ─── Validação ───

    function test_Execute_RevertsIfPreLiquidationNotApproved() public {
        PreMorphoLiquidationParams memory p = _params();
        p.preLiquidation = address(0xBADBAD);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(IZeusMorphoPreLiquidator.NotApprovedPreLiquidation.selector, address(0xBADBAD))
        );
        liq.executePreMorphoLiquidation(p);
    }

    /// @notice Prova a doutrina "sem modo inventário": swapSteps vazio é rejeitado.
    function test_Execute_RevertsOnEmptySwapSteps() public {
        PreMorphoLiquidationParams memory p = _params();
        p.swapSteps = new SwapStep[](0);
        vm.prank(operator);
        vm.expectRevert(IZeusMorphoPreLiquidator.EmptySwapSteps.selector);
        liq.executePreMorphoLiquidation(p);
    }

    function test_Execute_RevertsOnZeroBorrower() public {
        PreMorphoLiquidationParams memory p = _params();
        p.borrower = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusMorphoPreLiquidator.NotAuthorized.selector);
        liq.executePreMorphoLiquidation(p);
    }

    function test_Execute_RevertsOnZeroLoanToken() public {
        PreMorphoLiquidationParams memory p = _params();
        p.loanToken = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusMorphoPreLiquidator.NotAuthorized.selector);
        liq.executePreMorphoLiquidation(p);
    }

    // ─── Profit gate + accounting ───

    /// @notice Sem surplus → lucro 0 < minProfit → reverte (mock não chama callback, então _executeSwaps não roda).
    function test_Execute_RevertsOnInsufficientProfit() public {
        preLiq.setSurplus(0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IZeusMorphoPreLiquidator.InsufficientProfit.selector, 0, 1));
        liq.executePreMorphoLiquidation(_params());
    }

    /// @notice Com surplus → lucro vai pro profitReceiver (em loanToken/stable). Prova o accounting + transfer.
    function test_Execute_SuccessTransfersProfitToReceiver() public {
        uint256 surplus = 12_500_000; // 12.5 USDC (6 dec)
        preLiq.setSurplus(surplus);
        vm.prank(operator);
        liq.executePreMorphoLiquidation(_params());
        assertEq(loan.balanceOf(profitReceiver), surplus);
        assertEq(loan.balanceOf(address(liq)), 0);
    }

    // ─── Segurança do callback ───

    /// @notice Caller não-whitelisted chamando o callback direto → InvalidCaller.
    function test_onPreLiquidate_RevertsIfNotApproved() public {
        bytes memory data = abi.encode(address(loan), _steps());
        vm.prank(unauthorized);
        vm.expectRevert(IZeusMorphoPreLiquidator.InvalidCaller.selector);
        liq.onPreLiquidate(1000e6, data);
    }

    /// @notice Mesmo um PreLiquidation WHITELISTED chamando FORA do fluxo (sem flag transiente) → InvalidCaller.
    function test_onPreLiquidate_RevertsOutOfContextEvenIfApproved() public {
        bytes memory data = abi.encode(address(loan), _steps());
        vm.expectRevert(IZeusMorphoPreLiquidator.InvalidCaller.selector);
        preLiq.pokeCallback(address(liq), 1000e6, data);
    }

    // ─── Admin ───

    function test_Admin_KillReviveCycle() public {
        vm.startPrank(owner);
        liq.kill();
        assertTrue(liq.isKilled());
        liq.revive();
        assertFalse(liq.isKilled());
        vm.stopPrank();
    }

    function test_Admin_SettersOwnerOnly() public {
        vm.startPrank(unauthorized);
        vm.expectRevert();
        liq.setOperator(unauthorized, true);
        vm.expectRevert();
        liq.setApprovedPreLiquidation(address(0xABCD), true);
        vm.expectRevert();
        liq.setMaxTradeWei(1);
        vm.expectRevert();
        liq.kill();
        vm.stopPrank();
    }

    function test_Admin_SetApprovedPreLiquidation() public {
        vm.prank(owner);
        liq.setApprovedPreLiquidation(address(0xABCD), true);
        assertTrue(liq.isApprovedPreLiquidation(address(0xABCD)));
        vm.prank(owner);
        liq.setApprovedPreLiquidation(address(0xABCD), false);
        assertFalse(liq.isApprovedPreLiquidation(address(0xABCD)));
    }

    function test_Admin_RevertsOnZeroApprovedPreLiquidation() public {
        vm.prank(owner);
        vm.expectRevert(IZeusMorphoPreLiquidator.NotAuthorized.selector);
        liq.setApprovedPreLiquidation(address(0), true);
    }
}
