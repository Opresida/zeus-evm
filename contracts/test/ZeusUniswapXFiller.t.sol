// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ZeusUniswapXFiller} from "../src/ZeusUniswapXFiller.sol";
import {IZeusUniswapXFiller, UniswapXFillParams} from "../src/interfaces/IZeusUniswapXFiller.sol";
import {IReactorCallback, ResolvedOrder, SignedOrder} from "../src/interfaces/uniswapx/IReactor.sol";
import {SwapStep, DexType} from "../src/interfaces/IZeusExecutor.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Mock do reactor UniswapX. Simula um fill lucrativo SEM chamar o callback (evita DEX real no unit):
///      `executeWithCallback` apenas minta o surplus de profitToken no filler (= lucro). Também expõe um
///      disparo direto do callback FORA de contexto (pra provar o guard da flag transiente).
contract MockReactor {
    MockERC20 public immutable PROFIT;
    uint256 public surplus;

    constructor(MockERC20 p) {
        PROFIT = p;
    }

    function setSurplus(uint256 s) external {
        surplus = s;
    }

    function executeWithCallback(SignedOrder calldata, bytes calldata) external payable {
        if (surplus > 0) PROFIT.mint(msg.sender, surplus);
    }

    function pokeCallback(address target, ResolvedOrder[] calldata orders, bytes calldata data) external {
        IReactorCallback(target).reactorCallback(orders, data);
    }
}

/// @title ZeusUniswapXFillerTest — adversariais (unit):
///   1. Constructor (owner + maxTrade + starts killed)
///   2. Auth (operator gate, kill switch)
///   3. Validação (whitelist default-deny de reactor, swapSteps obrigatório, zero-addrs)
///   4. Profit gate (InsufficientProfit) + happy accounting (surplus → profitReceiver)
///   5. Callback security (não-whitelisted + fora de contexto via flag transiente)
///   6. Admin (setOperator, setApprovedReactor, setMaxTrade, kill/revive — owner only)
contract ZeusUniswapXFillerTest is Test {
    ZeusUniswapXFiller public filler;
    MockERC20 public usdc;
    MockReactor public reactor;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public unauthorized = makeAddr("unauthorized");
    address public profitReceiver = makeAddr("profitReceiver");

    address constant FAKE_TOKEN = address(0x4200000000000000000000000000000000000006); // WETH
    uint256 public constant INITIAL_MAX_TRADE_WEI = 100 ether;

    function setUp() public {
        usdc = new MockERC20();
        reactor = new MockReactor(usdc);
        filler = new ZeusUniswapXFiller(owner, INITIAL_MAX_TRADE_WEI);
        vm.startPrank(owner);
        filler.revive();
        filler.setOperator(operator, true);
        filler.setApprovedReactor(address(reactor), true);
        vm.stopPrank();
    }

    function _steps() internal view returns (SwapStep[] memory s) {
        s = new SwapStep[](1);
        s[0] = SwapStep({
            router: address(0x1234),
            tokenIn: FAKE_TOKEN,
            tokenOut: address(usdc),
            amountIn: 0,
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(uint24(500))
        });
    }

    function _params() internal view returns (UniswapXFillParams memory p) {
        p.reactor = address(reactor);
        p.order = SignedOrder({order: hex"00", sig: hex"00"});
        p.swapSteps = _steps();
        p.profitToken = address(usdc);
        p.minProfitWei = 1;
        p.profitReceiver = profitReceiver;
    }

    // ─── Constructor ───

    function test_Constructor_SetsState() public view {
        assertEq(filler.owner(), owner);
        assertEq(filler.maxTradeWei(), INITIAL_MAX_TRADE_WEI);
    }

    function test_Constructor_StartsKilled() public {
        ZeusUniswapXFiller fresh = new ZeusUniswapXFiller(owner, INITIAL_MAX_TRADE_WEI);
        assertTrue(fresh.isKilled());
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert();
        new ZeusUniswapXFiller(address(0), INITIAL_MAX_TRADE_WEI);
    }

    // ─── Auth ───

    function test_Execute_RevertsIfNotOperator() public {
        vm.prank(unauthorized);
        vm.expectRevert(IZeusUniswapXFiller.NotAuthorized.selector);
        filler.executeFill(_params());
    }

    function test_Execute_RevertsIfKilled() public {
        vm.prank(owner);
        filler.kill();
        vm.prank(operator);
        vm.expectRevert(IZeusUniswapXFiller.BotKilled.selector);
        filler.executeFill(_params());
    }

    // ─── Validação ───

    function test_Execute_RevertsIfReactorNotApproved() public {
        UniswapXFillParams memory p = _params();
        p.reactor = address(0xBADBAD);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IZeusUniswapXFiller.NotApprovedReactor.selector, address(0xBADBAD)));
        filler.executeFill(p);
    }

    /// @notice Doutrina "sem inventário": swapSteps vazio é rejeitado.
    function test_Execute_RevertsOnEmptySwapSteps() public {
        UniswapXFillParams memory p = _params();
        p.swapSteps = new SwapStep[](0);
        vm.prank(operator);
        vm.expectRevert(IZeusUniswapXFiller.EmptySwapSteps.selector);
        filler.executeFill(p);
    }

    function test_Execute_RevertsOnZeroProfitToken() public {
        UniswapXFillParams memory p = _params();
        p.profitToken = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusUniswapXFiller.NotAuthorized.selector);
        filler.executeFill(p);
    }

    function test_Execute_RevertsOnZeroReceiver() public {
        UniswapXFillParams memory p = _params();
        p.profitReceiver = address(0);
        vm.prank(operator);
        vm.expectRevert(IZeusUniswapXFiller.NotAuthorized.selector);
        filler.executeFill(p);
    }

    // ─── Profit gate + accounting ───

    function test_Execute_RevertsOnInsufficientProfit() public {
        reactor.setSurplus(0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(IZeusUniswapXFiller.InsufficientProfit.selector, 0, 1));
        filler.executeFill(_params());
    }

    /// @notice Com surplus → lucro vai pro profitReceiver. Prova accounting + transfer.
    function test_Execute_SuccessTransfersProfitToReceiver() public {
        uint256 surplus = 9_300_000; // 9.3 USDC
        reactor.setSurplus(surplus);
        vm.prank(operator);
        filler.executeFill(_params());
        assertEq(usdc.balanceOf(profitReceiver), surplus);
        assertEq(usdc.balanceOf(address(filler)), 0);
    }

    // ─── Segurança do callback ───

    function test_reactorCallback_RevertsIfNotApproved() public {
        ResolvedOrder[] memory orders = new ResolvedOrder[](0);
        bytes memory data = abi.encode(_steps());
        vm.prank(unauthorized);
        vm.expectRevert(IZeusUniswapXFiller.InvalidCaller.selector);
        filler.reactorCallback(orders, data);
    }

    /// @notice Mesmo um reactor WHITELISTED chamando FORA do fluxo (sem flag transiente) → InvalidCaller.
    function test_reactorCallback_RevertsOutOfContextEvenIfApproved() public {
        ResolvedOrder[] memory orders = new ResolvedOrder[](0);
        bytes memory data = abi.encode(_steps());
        vm.expectRevert(IZeusUniswapXFiller.InvalidCaller.selector);
        reactor.pokeCallback(address(filler), orders, data);
    }

    // ─── Admin ───

    function test_Admin_KillReviveCycle() public {
        vm.startPrank(owner);
        filler.kill();
        assertTrue(filler.isKilled());
        filler.revive();
        assertFalse(filler.isKilled());
        vm.stopPrank();
    }

    function test_Admin_SettersOwnerOnly() public {
        vm.startPrank(unauthorized);
        vm.expectRevert();
        filler.setOperator(unauthorized, true);
        vm.expectRevert();
        filler.setApprovedReactor(address(0xABCD), true);
        vm.expectRevert();
        filler.setMaxTradeWei(1);
        vm.expectRevert();
        filler.kill();
        vm.stopPrank();
    }

    function test_Admin_SetApprovedReactor() public {
        vm.prank(owner);
        filler.setApprovedReactor(address(0xABCD), true);
        assertTrue(filler.isApprovedReactor(address(0xABCD)));
        vm.prank(owner);
        filler.setApprovedReactor(address(0xABCD), false);
        assertFalse(filler.isApprovedReactor(address(0xABCD)));
    }

    function test_Admin_RevertsOnZeroApprovedReactor() public {
        vm.prank(owner);
        vm.expectRevert(IZeusUniswapXFiller.NotAuthorized.selector);
        filler.setApprovedReactor(address(0), true);
    }
}
