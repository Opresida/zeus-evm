// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { BribeManager } from "../src/BribeManager.sol";
import { ZeusLiquidator } from "../src/ZeusLiquidator.sol";
import { ZeusArbExecutor } from "../src/ZeusArbExecutor.sol";

/**
 * @notice Deploy script v8 — deploya 2 contratos separados:
 *   - ZeusLiquidator: liquidations (Aave + Compound + Morpho) com/sem bribe
 *   - ZeusArbExecutor: arb + flashloan arb + backrun com bribe
 *
 * Refatoração feita pra resolver EIP-170 (24576 byte limit). Cada contrato fica
 * confortavelmente abaixo do limit + Compound/Morpho recuperam suporte a bribe.
 *
 * Uso:
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $BASE_SEPOLIA_RPC_HTTP \
 *     --private-key $EXECUTOR_PRIVATE_KEY \
 *     --broadcast --verify
 *
 * Pós-deploy:
 *   - Ambos contratos começam com KILL switch ATIVO
 *   - Owner precisa chamar revive() em CADA contrato pra ativar
 *   - Owner precisa chamar setOperator(<bot>, true) em CADA contrato
 *   - WETH + UniV3 SwapRouter setados automaticamente em CADA contrato (se chain conhecida)
 */
contract DeployScript is Script {
    // ─── Aave V3 Pool por chainId ───
    address constant AAVE_V3_POOL_BASE_MAINNET = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant AAVE_V3_POOL_BASE_SEPOLIA = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address constant AAVE_V3_POOL_ARBITRUM = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant AAVE_V3_POOL_ARBITRUM_SEPOLIA = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    address constant AAVE_V3_POOL_OPTIMISM = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address constant AAVE_V3_POOL_OPTIMISM_SEPOLIA = 0xb50201558B00496A145fE76f7424749556E326D8;
    address constant AAVE_V3_POOL_POLYGON = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    // ─── WETH9 + UniV3 SwapRouter02 (pra bribe via swap inline) ───
    address constant WETH_BASE_MAINNET = 0x4200000000000000000000000000000000000006;
    address constant UNIV3_SWAP_ROUTER_BASE_MAINNET = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant WETH_BASE_SEPOLIA = 0x4200000000000000000000000000000000000006;
    address constant UNIV3_SWAP_ROUTER_BASE_SEPOLIA = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address constant WETH_ARBITRUM = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant UNIV3_SWAP_ROUTER_ARBITRUM = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant WETH_ARBITRUM_SEPOLIA = 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73;
    address constant UNIV3_SWAP_ROUTER_ARBITRUM_SEPOLIA = 0x101F443B4d1b059569D643917553c771E1b9663E;
    address constant WETH_OPTIMISM = 0x4200000000000000000000000000000000000006;
    address constant UNIV3_SWAP_ROUTER_OPTIMISM = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant WETH_OPTIMISM_SEPOLIA = 0x4200000000000000000000000000000000000006;
    address constant UNIV3_SWAP_ROUTER_OPTIMISM_SEPOLIA = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    // Polygon: nativo é POL → o "WETH" do bribe é o WRAPPED NATIVE (WPOL), não a WETH bridged.
    address constant WETH_POLYGON = 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270; // WPOL (wrapped native)
    address constant UNIV3_SWAP_ROUTER_POLYGON = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45; // SwapRouter02

    uint256 constant DEFAULT_MAX_TRADE_WEI_MAINNET = 0.1 ether;
    uint256 constant DEFAULT_MAX_TRADE_WEI_TESTNET = 0.01 ether;

    function run()
        external
        returns (BribeManager bribeManager, ZeusLiquidator liquidator, ZeusArbExecutor arbExecutor)
    {
        address aavePool = _resolveAavePool();
        address owner = _resolveOwner();
        uint256 maxTradeWei = _resolveMaxTradeWei();
        (address weth, address swapRouter) = _resolveWethAndSwapRouter();

        console2.log("=== Zeus Deploy v8 (3 contracts) ===");
        console2.log("Chain ID:", block.chainid);
        console2.log("Aave V3 Pool:", aavePool);
        console2.log("Initial owner:", owner);
        console2.log("Initial maxTradeWei:", maxTradeWei);
        console2.log("WETH:", weth);
        console2.log("UniV3 SwapRouter02:", swapRouter);
        console2.log("");

        vm.startBroadcast();

        // 1) Deploy BribeManager (compartilhado pelos 2 executors)
        bribeManager = new BribeManager();

        // 2) Deploy ZeusLiquidator (recebe BribeManager imutável)
        liquidator = new ZeusLiquidator(aavePool, address(bribeManager), owner, maxTradeWei);
        if (owner == msg.sender) {
            if (weth != address(0)) liquidator.setWeth(weth);
            if (swapRouter != address(0)) liquidator.setUniV3SwapRouter(swapRouter);
        }

        // 3) Deploy ZeusArbExecutor (recebe MESMO BribeManager imutável)
        arbExecutor = new ZeusArbExecutor(aavePool, address(bribeManager), owner, maxTradeWei);
        if (owner == msg.sender) {
            if (weth != address(0)) arbExecutor.setWeth(weth);
            if (swapRouter != address(0)) arbExecutor.setUniV3SwapRouter(swapRouter);
        }

        vm.stopBroadcast();

        console2.log("BribeManager deployed:", address(bribeManager));
        console2.log("ZeusLiquidator deployed:", address(liquidator));
        console2.log("  BRIBE_MANAGER():", liquidator.BRIBE_MANAGER());
        console2.log("  weth():", liquidator.weth());
        console2.log("  uniV3SwapRouter():", liquidator.uniV3SwapRouter());
        console2.log("ZeusArbExecutor deployed:", address(arbExecutor));
        console2.log("  BRIBE_MANAGER():", arbExecutor.BRIBE_MANAGER());
        console2.log("  weth():", arbExecutor.weth());
        console2.log("  uniV3SwapRouter():", arbExecutor.uniV3SwapRouter());
        console2.log("");
        console2.log("Next steps (CADA executor - Liquidator + ArbExecutor):");
        console2.log("  1) Owner chama revive() pra desativar kill switch");
        console2.log("  2) Owner chama setOperator(<bot_address>, true)");
        console2.log("  3) Se owner != deployer, chamar setWeth + setUniV3SwapRouter manualmente");
        console2.log("  4) Fundear bot wallet com pequeno saldo de gas");
        console2.log("");
        console2.log("BribeManager nao precisa de revive/operator - eh stateless");
    }

    function _resolveAavePool() internal view returns (address) {
        if (block.chainid == 8453) return AAVE_V3_POOL_BASE_MAINNET;
        if (block.chainid == 84532) return AAVE_V3_POOL_BASE_SEPOLIA;
        if (block.chainid == 42161) return AAVE_V3_POOL_ARBITRUM;
        if (block.chainid == 421614) return AAVE_V3_POOL_ARBITRUM_SEPOLIA;
        if (block.chainid == 10) return AAVE_V3_POOL_OPTIMISM;
        if (block.chainid == 11155420) return AAVE_V3_POOL_OPTIMISM_SEPOLIA;
        if (block.chainid == 137) return AAVE_V3_POOL_POLYGON;

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
        if (
            block.chainid == 8453 || block.chainid == 42161 || block.chainid == 10
                || block.chainid == 137
        ) {
            return DEFAULT_MAX_TRADE_WEI_MAINNET;
        }
        return DEFAULT_MAX_TRADE_WEI_TESTNET;
    }

    function _resolveWethAndSwapRouter() internal view returns (address weth, address swapRouter) {
        try vm.envAddress("DEPLOY_WETH_OVERRIDE") returns (address w) {
            if (w != address(0)) weth = w;
        } catch {}
        try vm.envAddress("DEPLOY_UNIV3_SWAP_ROUTER_OVERRIDE") returns (address r) {
            if (r != address(0)) swapRouter = r;
        } catch {}
        if (weth != address(0) && swapRouter != address(0)) return (weth, swapRouter);

        if (block.chainid == 8453) return (WETH_BASE_MAINNET, UNIV3_SWAP_ROUTER_BASE_MAINNET);
        if (block.chainid == 84532) return (WETH_BASE_SEPOLIA, UNIV3_SWAP_ROUTER_BASE_SEPOLIA);
        if (block.chainid == 42161) return (WETH_ARBITRUM, UNIV3_SWAP_ROUTER_ARBITRUM);
        if (block.chainid == 421614) return (WETH_ARBITRUM_SEPOLIA, UNIV3_SWAP_ROUTER_ARBITRUM_SEPOLIA);
        if (block.chainid == 10) return (WETH_OPTIMISM, UNIV3_SWAP_ROUTER_OPTIMISM);
        if (block.chainid == 11155420) return (WETH_OPTIMISM_SEPOLIA, UNIV3_SWAP_ROUTER_OPTIMISM_SEPOLIA);
        if (block.chainid == 137) return (WETH_POLYGON, UNIV3_SWAP_ROUTER_POLYGON);
        return (address(0), address(0));
    }
}
