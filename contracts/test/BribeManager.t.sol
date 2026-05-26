// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {BribeManager} from "../src/BribeManager.sol";
import {IBribeManager, BribeConfig} from "../src/interfaces/IBribeManager.sol";

/// @title BribeManagerTest — adversariais da BribeConfig validation + entry points.
/// @notice Cobre apenas o que dá pra testar standalone (sem fork): config validation +
///         interface checks. Path de bribe completo fica nos fork tests (testnet/mainnet).
contract BribeManagerTest is Test {
    BribeManager public bribeManager;

    function setUp() public {
        bribeManager = new BribeManager();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  validateConfig — exhaustive coverage
    // ═══════════════════════════════════════════════════════════════════════

    function test_ValidateConfig_AcceptsNoOp() public view {
        // (0, 0) é o no-op canônico — não reverte
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 0,
            minBribeWei: 0,
            bribeMaxBps: 0,
            swapFeeTier: 0,
            swapSlippageBps: 0
        });
        bribeManager.validateConfig(bribe);
    }

    function test_ValidateConfig_AcceptsValid() public view {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 1 ether,
            bribeMaxBps: 9_000,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        bribeManager.validateConfig(bribe);
    }

    function test_ValidateConfig_RejectsZeroBpsWithFloor() public {
        // Audit Pass 3 M-03: bribeBps=0 && minBribeWei>0 é incoerente
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 0,
            minBribeWei: 1 ether,
            bribeMaxBps: 9_000,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        vm.expectRevert(IBribeManager.InvalidBribeConfig.selector);
        bribeManager.validateConfig(bribe);
    }

    function test_ValidateConfig_RejectsBpsAbove10000() public {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 10_001,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        vm.expectRevert(IBribeManager.InvalidBribeConfig.selector);
        bribeManager.validateConfig(bribe);
    }

    function test_ValidateConfig_RejectsMaxBpsAboveCap() public {
        // bribeMaxBps > 9900 = acima do ABSOLUTE_BRIBE_CAP_BPS
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_901,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        vm.expectRevert(IBribeManager.InvalidBribeConfig.selector);
        bribeManager.validateConfig(bribe);
    }

    function test_ValidateConfig_RejectsZeroMaxBps() public {
        // bribeMaxBps=0 com bribeBps>0 = sem cap = inválido
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 0,
            swapFeeTier: 500,
            swapSlippageBps: 50
        });
        vm.expectRevert(IBribeManager.InvalidBribeConfig.selector);
        bribeManager.validateConfig(bribe);
    }

    function test_ValidateConfig_RejectsExcessiveSlippage() public {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 5_000,
            minBribeWei: 0,
            bribeMaxBps: 9_000,
            swapFeeTier: 500,
            swapSlippageBps: 1_001 // > 10%
        });
        vm.expectRevert(IBribeManager.InvalidBribeConfig.selector);
        bribeManager.validateConfig(bribe);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  pay() — early returns + revert paths que NÃO dependem de tokens reais
    // ═══════════════════════════════════════════════════════════════════════

    function test_Pay_NoOpReturnsZero() public {
        BribeConfig memory bribe = BribeConfig({
            bribeBps: 0,
            minBribeWei: 0,
            bribeMaxBps: 0,
            swapFeeTier: 0,
            swapSlippageBps: 0
        });
        // grossProfit irrelevante quando no-op
        (uint256 nativeWei, uint256 consumed) = bribeManager.pay(
            address(0x1), 100 ether, bribe, address(0x2), address(0x3),
            IBribeManager.BribeOpType.LiquidationWithBribe, address(0xBEEF)
        );
        assertEq(nativeWei, 0);
        assertEq(consumed, 0);
    }

    function test_Pay_RevertsWhenBribeExceedsProfit() public {
        // Cenário fork-only: precisa WETH + UniV3 router reais.
        vm.skip(true);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Audit Pass 4 — fix M-02: receive() rejeita ETH externo
    // ═══════════════════════════════════════════════════════════════════════

    function test_AuditP4_M02_ReceiveRejectsExternalEth() public {
        // M-02: receive() não aceita ETH de QUALQUER endereço — só durante pay() ativa.
        // Antes da v8.1: aceitava qualquer ETH (preso permanente, sem rescue).
        // Agora: reverte com NotAuthorizedCaller fora do contexto de pay().
        vm.deal(address(this), 1 ether);
        vm.expectRevert(IBribeManager.NotAuthorizedCaller.selector);
        (bool ok,) = payable(address(bribeManager)).call{value: 0.5 ether}("");
        ok; // silence unused warning — expectRevert validates the revert
        assertEq(address(bribeManager).balance, 0);
    }

    function test_AuditP4_M02_ReceiveRejectsRandomSender() public {
        // Atacante tenta forçar ETH preso no BribeManager
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 5 ether);
        vm.prank(attacker);
        vm.expectRevert(IBribeManager.NotAuthorizedCaller.selector);
        (bool ok,) = payable(address(bribeManager)).call{value: 5 ether}("");
        ok; // silence unused warning — expectRevert validates the revert
        assertEq(address(bribeManager).balance, 0);
        // Atacante ainda tem o ETH dele (não foi consumido)
        assertEq(attacker.balance, 5 ether);
    }
}
