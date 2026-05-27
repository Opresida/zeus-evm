// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBribeManager, BribeConfig} from "../../src/interfaces/IBribeManager.sol";
import {BribeManager} from "../../src/BribeManager.sol";

interface IWETH9Test {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Contrato malicioso usado como block.coinbase pra testar B-6.
/// @dev Reverte ao receber ETH — simula builder hostil que tenta forçar nossa tx a reverter.
contract RejectingCoinbase {
    receive() external payable {
        revert("Reject!");
    }
}

/// @title BribeManagerB6B7ForkTest — testa fixes B-6 (coinbase DoS) e B-7 (transient flag).
///
/// B-6: builder hostil que rejeita ETH ANTES forçava revert da tx inteira. Agora:
///      bot perde o bribe (não entrega tip) mas mantém TODO o profit (re-wrap em WETH).
///
/// B-7: flag _payInProgress em transient storage — reset auto fim de tx. IMPOSSÍVEL
///      ficar travada em revert path. Tests verificam que M-02 guard funciona corretamente
///      antes/durante/depois de chamadas pay().
contract BribeManagerB6B7ForkTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER_V3 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    uint256 constant FORK_BLOCK = 28_000_000;
    uint24 constant USDC_WETH_FEE = 500;

    BribeManager public bribeManager;
    address public caller;
    RejectingCoinbase public maliciousCoinbase;

    event BribeCoinbaseFallback(
        address indexed initiator,
        IBribeManager.BribeOpType indexed opType,
        address indexed coinbase,
        address recipient,
        uint256 bribeNativeWei,
        uint256 grossProfit
    );

    event BribePaid(
        address indexed initiator,
        IBribeManager.BribeOpType indexed opType,
        address indexed coinbase,
        uint256 bribeNativeWei,
        uint256 grossProfit,
        uint256 netProfit
    );

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_HTTP", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);

        bribeManager = new BribeManager();
        caller = makeAddr("caller");
        maliciousCoinbase = new RejectingCoinbase();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  B-6 — coinbase malicioso NÃO força revert da tx inteira
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_B6_HostileCoinbase_WethFastPath_FallsBackToOperator() public {
        // Configura coinbase como contrato que rejeita ETH (builder hostil)
        vm.coinbase(address(maliciousCoinbase));

        uint256 grossProfit = 10 ether;
        deal(WETH, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 0,
            swapSlippageBps: 0
        });

        vm.prank(caller);
        IWETH9Test(WETH).approve(address(bribeManager), grossProfit);

        uint256 operatorWethBefore = IWETH9Test(WETH).balanceOf(caller);

        // Expect fallback event (não revert!)
        vm.expectEmit(true, true, true, true);
        emit BribeCoinbaseFallback(
            caller,
            IBribeManager.BribeOpType.FlashloanBackrun,
            address(maliciousCoinbase),
            caller,
            5 ether,
            grossProfit
        );

        vm.prank(caller);
        (uint256 bribeNativeWei, uint256 consumed) = bribeManager.pay(
            WETH, grossProfit, bribe, WETH, address(0),
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // Bot NÃO recebeu zero — recebeu o bribe de volta em WETH (fallback)
        assertEq(bribeNativeWei, 5 ether);
        assertEq(consumed, 5 ether);

        // Caller começou com 10 WETH. Fluxo:
        //   1) pull -5 WETH (vira ETH no BribeManager via WETH9.withdraw)
        //   2) coinbase rejeita ETH → fallback:
        //      WETH9.deposit (re-wrap) + safeTransfer(operator=caller, 5 ether)
        //   Saldo final: 10 - 5 + 5 = 10 (deslocamento líquido = 0)
        // Bot mantém TODO o profit — só perde o tip de inclusion (coinbase recusou).
        uint256 operatorWethAfter = IWETH9Test(WETH).balanceOf(caller);
        assertEq(operatorWethAfter, operatorWethBefore);
        assertEq(operatorWethAfter, 10 ether);

        // Coinbase malicioso NÃO recebeu ETH
        assertEq(address(maliciousCoinbase).balance, 0);

        // BribeManager limpo (sem ETH preso)
        assertEq(address(bribeManager).balance, 0);
        assertEq(IWETH9Test(WETH).balanceOf(address(bribeManager)), 0);
    }

    function test_Fork_B6_HostileCoinbase_UsdcSlowPath_FallsBackToOperator() public {
        // Mesmo cenário B-6 mas no path slow (USDC → WETH swap)
        vm.coinbase(address(maliciousCoinbase));

        uint256 grossProfit = 10_000e6;
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

        uint256 operatorWethBefore = IWETH9Test(WETH).balanceOf(caller);
        uint256 operatorUsdcBefore = IERC20(USDC).balanceOf(caller);

        vm.prank(caller);
        (uint256 bribeNativeWei, uint256 consumed) = bribeManager.pay(
            USDC, grossProfit, bribe, WETH, SWAP_ROUTER_V3,
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // Bribe foi calculado (swap rodou), mas coinbase rejeitou → fallback
        assertGt(bribeNativeWei, 0);
        assertEq(consumed, 5_000e6); // 50% de 10k USDC swapados

        // Operator recebeu WETH de volta (re-wrapped do ETH que coinbase rejeitou)
        uint256 operatorWethAfter = IWETH9Test(WETH).balanceOf(caller);
        assertEq(operatorWethAfter - operatorWethBefore, bribeNativeWei);

        // USDC consumido pelo swap (não tem volta no path slow — já foi pra pool)
        assertEq(operatorUsdcBefore - IERC20(USDC).balanceOf(caller), 5_000e6);

        // Coinbase malicioso NÃO recebeu ETH
        assertEq(address(maliciousCoinbase).balance, 0);

        // BribeManager limpo
        assertEq(address(bribeManager).balance, 0);
        assertEq(IWETH9Test(WETH).balanceOf(address(bribeManager)), 0);
    }

    function test_Fork_B6_FriendlyCoinbase_StillEmitsBribePaid() public {
        // Regressão: coinbase normal (EOA) ainda emite BribePaid (path original)
        address friendlyCoinbase = makeAddr("friendlyCoinbase");
        vm.coinbase(friendlyCoinbase);

        uint256 grossProfit = 10 ether;
        deal(WETH, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 0,
            swapSlippageBps: 0
        });

        vm.prank(caller);
        IWETH9Test(WETH).approve(address(bribeManager), grossProfit);

        vm.expectEmit(true, true, true, true);
        emit BribePaid(
            caller,
            IBribeManager.BribeOpType.FlashloanBackrun,
            friendlyCoinbase,
            5 ether,
            grossProfit,
            grossProfit - 5 ether
        );

        vm.prank(caller);
        bribeManager.pay(
            WETH, grossProfit, bribe, WETH, address(0),
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // Coinbase amigável recebeu o bribe normal
        assertEq(friendlyCoinbase.balance, 5 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  B-7 — transient storage: flag NUNCA fica travada
    // ═══════════════════════════════════════════════════════════════════════

    function test_Fork_B7_TransientFlag_ResetsAutomaticallyAfterTx() public {
        // Cenário: pay() roda e completa. Em CALL externa subsequente (outra tx),
        // _payInProgress já está false novamente (transient resetou).
        address friendlyCoinbase = makeAddr("friendlyCoinbase");
        vm.coinbase(friendlyCoinbase);

        uint256 grossProfit = 10 ether;
        deal(WETH, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 0,
            swapSlippageBps: 0
        });

        vm.prank(caller);
        IWETH9Test(WETH).approve(address(bribeManager), grossProfit);

        vm.prank(caller);
        bribeManager.pay(
            WETH, grossProfit, bribe, WETH, address(0),
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // Tx anterior terminou. Próxima tx do attacker tentando mandar ETH:
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 1 ether);

        // M-02 guard deve estar ATIVA (transient resetou — flag = false)
        vm.prank(attacker);
        vm.expectRevert(IBribeManager.NotAuthorizedCaller.selector);
        (bool ok,) = payable(address(bribeManager)).call{value: 0.5 ether}("");
        ok;
    }

    function test_Fork_B7_TransientFlag_ResetsEvenAfterRevert() public {
        // Cenário: pay() reverte no meio (swap fail). Flag transient resetou auto.
        // Próxima tentativa de ETH externo deve reverter (M-02 guard intacta).
        uint256 grossProfit = 100e6; // 100 USDC — pouco pra swap atingir floor alto
        deal(USDC, caller, grossProfit);

        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 100 ether,  // impossível — força swap reverter
            bribeMaxBps: 9_000,
            swapFeeTier: USDC_WETH_FEE,
            swapSlippageBps: 100
        });

        vm.prank(caller);
        IERC20(USDC).approve(address(bribeManager), grossProfit);

        // Pay() vai reverter (swap não atinge floor)
        vm.prank(caller);
        vm.expectRevert(IBribeManager.BribeSwapFailed.selector);
        bribeManager.pay(
            USDC, grossProfit, bribe, WETH, SWAP_ROUTER_V3,
            IBribeManager.BribeOpType.FlashloanBackrun, caller
        );

        // Tx anterior reverteu COMPLETAMENTE. Transient storage reset auto.
        // Próxima tx: M-02 guard ATIVA (flag = false porque tx anterior toda reverteu).
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 1 ether);

        vm.prank(attacker);
        vm.expectRevert(IBribeManager.NotAuthorizedCaller.selector);
        (bool ok,) = payable(address(bribeManager)).call{value: 0.5 ether}("");
        ok;
        assertEq(address(bribeManager).balance, 0);
    }

    function test_Fork_B7_TransientFlag_DoesNotPersistAcrossCalls() public {
        // Verifica explicitamente que TLOAD retorna 0 fora de pay().
        // Como `_isPayInProgress` é internal, testamos via receive() guard.
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 1 ether);

        // Antes de qualquer pay() — flag = false
        vm.prank(attacker);
        vm.expectRevert(IBribeManager.NotAuthorizedCaller.selector);
        (bool ok1,) = payable(address(bribeManager)).call{value: 0.1 ether}("");
        ok1;

        // Depois de qualquer pay() — flag também = false (transient resetou)
        // (já testado em test_Fork_B7_TransientFlag_ResetsAutomaticallyAfterTx)
        assertEq(address(bribeManager).balance, 0);
    }
}
