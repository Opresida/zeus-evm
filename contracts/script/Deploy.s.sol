// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { ZeusExecutor } from "../src/ZeusExecutor.sol";

/**
 * @notice Deploy script pro ZeusExecutor.
 *
 * Uso:
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_HTTP \
 *     --private-key $EXECUTOR_PRIVATE_KEY \
 *     --broadcast --verify
 *
 * Detecta chain via block.chainid e usa endereços hardcoded do Aave V3.
 *
 * Constructor:
 *   - aaveV3Pool: endereço do Aave V3 Pool na chain alvo
 *   - initialOwner: msg.sender (broadcaster) por padrão; override via INITIAL_OWNER env
 *   - initialMaxTradeWei: 0.01 ETH em Sepolia, 0.1 ETH em mainnet (override via env)
 *
 * Pós-deploy:
 *   - Contrato começa com KILL switch ATIVO (constructor seta _killed=true)
 *   - Owner precisa chamar revive() pra ativar
 *   - Owner precisa chamar setOperator(executor, true) pra autorizar bot
 */
contract DeployScript is Script {
    // ─── Endereços oficiais Aave V3 ───
    address constant AAVE_V3_POOL_BASE_MAINNET = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant AAVE_V3_POOL_BASE_SEPOLIA = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;

    // ─── Defaults de maxTradeWei (override via env) ───
    uint256 constant DEFAULT_MAX_TRADE_WEI_MAINNET = 0.1 ether;
    uint256 constant DEFAULT_MAX_TRADE_WEI_TESTNET = 0.01 ether;

    function run() external returns (ZeusExecutor executor) {
        // ─── 1) Resolver endereço Aave V3 pela chain atual ───
        address aavePool = _resolveAavePool();

        // ─── 2) Resolver owner (default: msg.sender) ───
        address owner = _resolveOwner();

        // ─── 3) Resolver maxTradeWei (default por chain) ───
        uint256 maxTradeWei = _resolveMaxTradeWei();

        console2.log("=== ZeusExecutor Deploy ===");
        console2.log("Chain ID:", block.chainid);
        console2.log("Aave V3 Pool:", aavePool);
        console2.log("Initial owner:", owner);
        console2.log("Initial maxTradeWei:", maxTradeWei);
        console2.log("");

        // ─── 4) Deploy ───
        vm.startBroadcast();
        executor = new ZeusExecutor(aavePool, owner, maxTradeWei);
        vm.stopBroadcast();

        console2.log("ZeusExecutor deployed:", address(executor));
        console2.log("");
        console2.log("Next steps:");
        console2.log("  1) Owner chama revive() pra desativar kill switch");
        console2.log("  2) Owner chama setOperator(<bot_address>, true)");
        console2.log("  3) Fundear executor com pequeno saldo de gas se necessario");
    }

    function _resolveAavePool() internal view returns (address) {
        // ChainId tem prioridade — endereços hardcoded são source of truth.
        // Override via env só pra chains não-suportadas (uso `DEPLOY_AAVE_V3_POOL_OVERRIDE`
        // pra evitar colisão com a var `AAVE_V3_POOL` que o detector usa pra mainnet).
        if (block.chainid == 8453) return AAVE_V3_POOL_BASE_MAINNET;
        if (block.chainid == 84532) return AAVE_V3_POOL_BASE_SEPOLIA;

        try vm.envAddress("DEPLOY_AAVE_V3_POOL_OVERRIDE") returns (address poolOverride) {
            if (poolOverride != address(0)) return poolOverride;
        } catch {}

        revert("Unsupported chain - set DEPLOY_AAVE_V3_POOL_OVERRIDE env var");
    }

    function _resolveOwner() internal view returns (address) {
        try vm.envAddress("INITIAL_OWNER") returns (address ownerOverride) {
            if (ownerOverride != address(0)) return ownerOverride;
        } catch {}
        return msg.sender;
    }

    function _resolveMaxTradeWei() internal view returns (uint256) {
        try vm.envUint("INITIAL_MAX_TRADE_WEI") returns (uint256 maxOverride) {
            if (maxOverride > 0) return maxOverride;
        } catch {}

        if (block.chainid == 8453) return DEFAULT_MAX_TRADE_WEI_MAINNET;
        return DEFAULT_MAX_TRADE_WEI_TESTNET;
    }
}
