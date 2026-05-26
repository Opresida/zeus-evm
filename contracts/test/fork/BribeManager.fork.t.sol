// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BribeManager} from "../../src/BribeManager.sol";
import {IBribeManager, BribeConfig} from "../../src/interfaces/IBribeManager.sol";

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @title BribeManager fork tests — exercitam o path real Base mainnet.
///
/// @notice Unit tests cobrem validation + revert paths. Fork tests cobrem o que
///         só dá pra testar contra contratos reais:
///           - WETH9.withdraw + receive ETH
///           - UniV3 SwapRouter02 exactInputSingle (path slow)
///           - block.coinbase.transfer end-to-end
///           - H-01 fix verificado: amountOutMinimum = minBribeWei
///
/// @dev Roda só se BASE_RPC_HTTP setado. Sem RPC, skip.
contract BribeManagerForkTest is Test {
    // Base mainnet addresses (chain-config/base.ts)
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER_V3 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // Fork block (qualquer bloco estável recente)
    uint256 constant FORK_BLOCK = 28_000_000;

    // Pool USDC/WETH 0.05% mais líquido em Base
    uint24 constant USDC_WETH_FEE = 500;

    BribeManager public bribeManager;
    address public caller; // "executor" simulado (Liquidator ou ArbExecutor)
    address public coinbaseAddr;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_HTTP", string(""));
        if (bytes(rpc).length == 0) {
            // Sem RPC, skip todos os tests
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        bribeManager = new BribeManager();
        caller = makeAddr("caller");
        coinbaseAddr = makeAddr("coinbase");

        // Set block.coinbase pra um EOA observável
        vm.coinbase(coinbaseAddr);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Fast path: profitToken == WETH
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_Pay_WETH_FastPath_PaysCoinbase() public {
        // Dá WETH pro caller (deal escreve no balanceOf direto)
        uint256 grossProfit = 10 ether;
        deal(WETH, caller, grossProfit);

        // Bribe 50% do profit
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 0, // fast path não usa swap
            swapSlippageBps: 0
        });

        // Caller approva BribeManager pra puxar WETH
        vm.prank(caller);
        IWETH9(WETH).approve(address(bribeManager), grossProfit);

        uint256 coinbaseBalBefore = coinbaseAddr.balance;
        uint256 callerWethBefore = IWETH9(WETH).balanceOf(caller);

        vm.prank(caller);
        (uint256 bribeNativeWei, uint256 consumed) = bribeManager.pay(
            WETH, grossProfit, bribe, WETH, address(0),
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // 50% de 10 = 5 ETH foi pro coinbase
        assertEq(bribeNativeWei, 5 ether);
        assertEq(consumed, 5 ether);
        assertEq(coinbaseAddr.balance - coinbaseBalBefore, 5 ether);
        // Caller perdeu 5 WETH
        assertEq(callerWethBefore - IWETH9(WETH).balanceOf(caller), 5 ether);
        // BribeManager não reteve ETH
        assertEq(address(bribeManager).balance, 0);
    }

    function test_Fork_Pay_WETH_FloorMinBribeRevertsIfExceedsProfit() public {
        // Caso: bribeProfitTarget < minBribeWei, e minBribeWei >= grossProfit
        // → BribeExceedsProfit
        uint256 grossProfit = 1 ether;
        deal(WETH, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 1_000, // 10% = 0.1 ETH
            minBribeWei: 2 ether, // mas piso de 2 ETH (acima do gross)
            bribeMaxBps: 9_000,
            swapFeeTier: 0,
            swapSlippageBps: 0
        });

        vm.prank(caller);
        IWETH9(WETH).approve(address(bribeManager), grossProfit);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(IBribeManager.BribeExceedsProfit.selector, uint256(2 ether), uint256(1 ether))
        );
        bribeManager.pay(
            WETH, grossProfit, bribe, WETH, address(0),
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );
    }

    function test_Fork_Pay_WETH_NoOpReturnsZero() public {
        deal(WETH, caller, 10 ether);
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 0, minBribeWei: 0, bribeMaxBps: 0, swapFeeTier: 0, swapSlippageBps: 0
        });

        vm.prank(caller);
        (uint256 nativeWei, uint256 consumed) = bribeManager.pay(
            WETH, 10 ether, bribe, WETH, address(0),
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );
        assertEq(nativeWei, 0);
        assertEq(consumed, 0);
        // Nada moveu
        assertEq(coinbaseAddr.balance, 0);
        assertEq(IWETH9(WETH).balanceOf(caller), 10 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Slow path: profitToken != WETH (swap inline)
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_Pay_USDC_SlowPath_SwapsAndPaysCoinbase() public {
        // 10.000 USDC de profit (6 decimals)
        uint256 grossProfit = 10_000e6;
        deal(USDC, caller, grossProfit);

        // bribe 50%, swap pelo pool 0.05% (mais líquido USDC/WETH)
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0, // sem floor pra validar happy path
            bribeMaxBps: 9_000,
            swapFeeTier: USDC_WETH_FEE,
            swapSlippageBps: 100
        });

        vm.prank(caller);
        IERC20(USDC).approve(address(bribeManager), grossProfit);

        uint256 coinbaseBalBefore = coinbaseAddr.balance;

        vm.prank(caller);
        (uint256 bribeNativeWei, uint256 consumed) = bribeManager.pay(
            USDC, grossProfit, bribe, WETH, SWAP_ROUTER_V3,
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // 50% de 10k USDC = 5k USDC swapados (consumed)
        assertEq(consumed, 5_000e6);
        // bribeNativeWei == WETH recebido do swap (depende do preço no fork block)
        assertGt(bribeNativeWei, 0);
        // Coinbase recebeu exatamente o que o swap rendeu
        assertEq(coinbaseAddr.balance - coinbaseBalBefore, bribeNativeWei);
        // BribeManager limpo
        assertEq(address(bribeManager).balance, 0);
        assertEq(IERC20(USDC).balanceOf(address(bribeManager)), 0);
        assertEq(IWETH9(WETH).balanceOf(address(bribeManager)), 0);
    }

    function test_Fork_Pay_USDC_H01_SandwichRevertsWhenSwapBelowMinBribe() public {
        // H-01 verification: amountOutMinimum agora == minBribeWei
        // Se atacante sandwich movesse o pool, swap retorna < minBribeWei → revert.
        // Aqui simulamos setando minBribeWei IMPOSSÍVEL de atingir (10x o esperado).
        uint256 grossProfit = 100e6; // 100 USDC
        deal(USDC, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 100 ether, // 50 USDC nunca vira 100 ETH
            bribeMaxBps: 9_000,
            swapFeeTier: USDC_WETH_FEE,
            swapSlippageBps: 100
        });

        vm.prank(caller);
        IERC20(USDC).approve(address(bribeManager), grossProfit);

        // UniV3 router reverte com "Too little received" quando amountOut < minimum.
        // BribeManager pega no catch e re-reverte com BribeSwapFailed.
        vm.prank(caller);
        vm.expectRevert(IBribeManager.BribeSwapFailed.selector);
        bribeManager.pay(
            USDC, grossProfit, bribe, WETH, SWAP_ROUTER_V3,
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // Após revert, USDC voltou pro caller (refund do catch)
        assertEq(IERC20(USDC).balanceOf(caller), grossProfit);
        assertEq(IERC20(USDC).balanceOf(address(bribeManager)), 0);
    }

    function test_Fork_Pay_USDC_RefundsOnSwapFailure() public {
        // Mesmo cenário do H-01 — confirma que catch faz refund completo
        uint256 grossProfit = 1_000e6;
        deal(USDC, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 1_000_000 ether, // impossível
            bribeMaxBps: 9_000,
            swapFeeTier: USDC_WETH_FEE,
            swapSlippageBps: 100
        });

        vm.prank(caller);
        IERC20(USDC).approve(address(bribeManager), grossProfit);

        vm.prank(caller);
        vm.expectRevert(IBribeManager.BribeSwapFailed.selector);
        bribeManager.pay(
            USDC, grossProfit, bribe, WETH, SWAP_ROUTER_V3,
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // Caller manteve TODO o USDC
        assertEq(IERC20(USDC).balanceOf(caller), grossProfit);
    }

    function test_Fork_Pay_USDC_RevertsOnZeroFeeTier() public {
        uint256 grossProfit = 1_000e6;
        deal(USDC, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 0, // ZERO no slow path = inválido
            swapSlippageBps: 100
        });

        vm.prank(caller);
        IERC20(USDC).approve(address(bribeManager), grossProfit);

        vm.prank(caller);
        vm.expectRevert(IBribeManager.InvalidBribeConfig.selector);
        bribeManager.pay(
            USDC, grossProfit, bribe, WETH, SWAP_ROUTER_V3,
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );
    }

    function test_Fork_Pay_RevertsOnZeroSwapRouter() public {
        uint256 grossProfit = 1_000e6;
        deal(USDC, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: USDC_WETH_FEE,
            swapSlippageBps: 100
        });

        vm.prank(caller);
        IERC20(USDC).approve(address(bribeManager), grossProfit);

        vm.prank(caller);
        vm.expectRevert(IBribeManager.SwapRouterNotConfigured.selector);
        bribeManager.pay(
            USDC, grossProfit, bribe, WETH, address(0),
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Audit Pass 4 — M-02 reaffirmation em fork
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_M02_ExternalEthRejectedEvenOnFork() public {
        // Confirma que M-02 fix funciona em fork real (estado pós-deploy)
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 10 ether);

        vm.prank(attacker);
        vm.expectRevert(IBribeManager.NotAuthorizedCaller.selector);
        (bool ok,) = payable(address(bribeManager)).call{value: 10 ether}("");
        ok;
        assertEq(address(bribeManager).balance, 0);
    }
}
