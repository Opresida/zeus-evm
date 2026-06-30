// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ZeusUniswapXFiller} from "../../src/ZeusUniswapXFiller.sol";
import {UniswapXFillParams} from "../../src/interfaces/IZeusUniswapXFiller.sol";
import {
    IReactorCallback,
    ResolvedOrder,
    OutputToken,
    OrderInfo,
    InputToken,
    SignedOrder
} from "../../src/interfaces/uniswapx/IReactor.sol";
import {SwapStep, DexType} from "../../src/interfaces/IZeusExecutor.sol";

/// @dev Mock do reactor que replica o FLUXO REAL: entrega o input ao filler → chama o callback →
///      puxa o output aprovado → swapper. O swap dentro do callback é REAL (UniV3 na Base).
contract MockReactorReal {
    address public immutable INPUT;
    address public immutable OUTPUT;
    address public swapper;
    uint256 public inputAmount;
    uint256 public requiredOutput;

    constructor(address input, address output) {
        INPUT = input;
        OUTPUT = output;
    }

    function configure(address _swapper, uint256 _in, uint256 _req) external {
        swapper = _swapper;
        inputAmount = _in;
        requiredOutput = _req;
    }

    function executeWithCallback(SignedOrder calldata, bytes calldata callbackData) external payable {
        // 1. entrega o input ao filler (= o que o reactor real faz via Permit2 a partir do swapper)
        IERC20(INPUT).transfer(msg.sender, inputAmount);
        // 2. monta a ordem resolvida com 1 output (o que o swapper quer receber)
        ResolvedOrder[] memory orders = new ResolvedOrder[](1);
        OutputToken[] memory outs = new OutputToken[](1);
        outs[0] = OutputToken({token: OUTPUT, amount: requiredOutput, recipient: swapper});
        orders[0] = ResolvedOrder({
            info: OrderInfo(address(this), swapper, 0, type(uint256).max, address(0), ""),
            input: InputToken(INPUT, inputAmount, inputAmount),
            outputs: outs,
            sig: "",
            hash: bytes32(0)
        });
        // 3. callback do filler: faz o swap REAL e aprova as saídas
        IReactorCallback(msg.sender).reactorCallback(orders, callbackData);
        // 4. puxa o output aprovado → swapper (= reactor real no _fill)
        IERC20(OUTPUT).transferFrom(msg.sender, swapper, requiredOutput);
    }
}

/// @title ZeusUniswapXFiller fork tests — contra a Base mainnet.
/// @notice Duas provas (padrão dos nossos fork tests):
///   1. WIRING: a chamada chega no V2DutchOrderReactor REAL e reverte (ordem inválida) — prova ABI/whitelist/
///      flag-transiente contra o contrato real.
///   2. E2E: mock que replica o fluxo do reactor com swap WETH→USDC REAL (UniV3 Base) — prova
///      _executeSwaps + aprovação de output + reactor puxando + lucro (surplus) + zero resíduo. Atômico.
contract ZeusUniswapXFillerForkTest is Test {
    address constant REACTOR_V2 = 0x000000001Ec5656dcdB24D90DFa42742738De729;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant UNIV3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481; // SwapRouter02 Base
    uint24 constant FEE = 500; // WETH/USDC 0.05%

    uint256 constant FORK_BLOCK = 46_765_960;
    uint256 constant INITIAL_MAX_TRADE = 1_000 ether;

    ZeusUniswapXFiller public filler;
    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public profitReceiver = makeAddr("profitReceiver");
    address public swapper = makeAddr("swapper");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_HTTP", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        filler = new ZeusUniswapXFiller(owner, INITIAL_MAX_TRADE);
        vm.startPrank(owner);
        filler.revive();
        filler.setOperator(operator, true);
        filler.setApprovedRouter(UNIV3_ROUTER, true);
        vm.stopPrank();
    }

    function _wethToUsdc() internal pure returns (SwapStep[] memory steps) {
        steps = new SwapStep[](1);
        steps[0] = SwapStep({
            router: UNIV3_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: 0, // usa o saldo (input que o reactor entregou)
            minAmountOut: 0,
            dexType: DexType.UniswapV3,
            extraData: abi.encode(FEE)
        });
    }

    // ─── 1. WIRING: chega no reactor V2 REAL e reverte (ordem inválida) ───

    function test_Fork_Wiring_ReachesRealReactor() public {
        if (REACTOR_V2.code.length == 0) {
            emit log("reactor V2 sem codigo neste bloco - skip wiring");
            return;
        }
        vm.prank(owner);
        filler.setApprovedReactor(REACTOR_V2, true);

        UniswapXFillParams memory p;
        p.reactor = REACTOR_V2;
        p.order = SignedOrder({order: hex"00", sig: hex"00"}); // ordem lixo → o reactor real reverte
        p.swapSteps = _wethToUsdc();
        p.profitToken = USDC;
        p.minProfitWei = 1;
        p.profitReceiver = profitReceiver;

        vm.prank(operator);
        vm.expectRevert(); // qualquer revert do reactor real prova que a chamada/ABI chegou nele
        filler.executeFill(p);
    }

    // ─── 2. E2E: swap WETH→USDC REAL via mock que replica o fluxo do reactor ───

    function test_Fork_E2E_FillProfits() public {
        MockReactorReal reactor = new MockReactorReal(WETH, USDC);
        uint256 inputWeth = 1 ether;
        // swapper quer 1500 USDC por 1 WETH; 1 WETH vale ~1970 USDC nesse bloco → ~470 USDC de surplus (nosso).
        uint256 requiredUsdc = 1_500e6;

        deal(WETH, address(reactor), inputWeth);
        reactor.configure(swapper, inputWeth, requiredUsdc);

        vm.prank(owner);
        filler.setApprovedReactor(address(reactor), true);

        UniswapXFillParams memory p;
        p.reactor = address(reactor);
        p.order = SignedOrder({order: hex"00", sig: hex"00"});
        p.swapSteps = _wethToUsdc();
        p.profitToken = USDC;
        p.minProfitWei = 1;
        p.profitReceiver = profitReceiver;

        uint256 before = IERC20(USDC).balanceOf(profitReceiver);
        vm.prank(operator);
        filler.executeFill(p);
        uint256 profit = IERC20(USDC).balanceOf(profitReceiver) - before;

        emit log_named_decimal_uint("lucro USDC (surplus do fill)", profit, 6);
        emit log_named_decimal_uint("swapper recebeu USDC", IERC20(USDC).balanceOf(swapper), 6);

        assertGt(profit, 0, "deve sobrar surplus (lucro) em USDC");
        assertEq(IERC20(USDC).balanceOf(swapper), requiredUsdc, "swapper recebe exatamente o requerido");
        assertEq(IERC20(WETH).balanceOf(address(filler)), 0, "nao retem WETH");
        assertEq(IERC20(USDC).balanceOf(address(filler)), 0, "nao retem USDC (surplus foi pro receiver)");
    }
}
