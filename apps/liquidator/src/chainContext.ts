/**
 * Resolve contexto multi-chain pro liquidator: client de leitura + (opcional) wallet de escrita.
 *
 * Compare com monitor/chainContext.ts: similar, mas adiciona walletClient pra submissão de tx.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ARBITRUM_MAINNET,
  ARBITRUM_SEPOLIA,
  BASE_MAINNET,
  BASE_SEPOLIA,
  OPTIMISM_MAINNET,
  OPTIMISM_SEPOLIA,
  POLYGON_MAINNET,
  type ChainConfig,
} from '@zeus-evm/chain-config';
import { arbitrum, arbitrumSepolia, base, baseSepolia, optimism, optimismSepolia, polygon } from 'viem/chains';

import type { LiquidatorEnv } from './config';

type AnyPublicClient = PublicClient<any, any>;
type AnyWalletClient = WalletClient<any, any, any>;

export interface LiquidatorChainContext {
  chainConfig: ChainConfig;
  rpcUrl: string;
  client: AnyPublicClient;
  /** Wallet pra submissão de tx. Pode ser undefined em dryrun mode. */
  wallet?: AnyWalletClient;
  /** Conta on-chain do wallet (= bot operator address). */
  account?: Address;
  /** ZeusExecutor address na chain ativa. Obrigatório em testnet/mainnet, opcional em dryrun. */
  executorContractAddress?: Address;
  /** Subgraph ID Aave V3 pra essa chain (pro liquidator reusar discovery). */
  subgraphId: string;
  /** Indica se essa chain é testnet (afeta sanity checks). */
  isTestnet: boolean;
}

interface ChainBlueprint {
  cfg: ChainConfig;
  rpc: string | undefined;
  subgraphId: string;
  viemChain: any;
  executorAddr: string | undefined;
}

export function getChainContext(env: LiquidatorEnv): LiquidatorChainContext {
  const chainId = env.CHAIN_ID;
  const bp = resolveBlueprint(env, chainId);

  if (!bp.rpc) {
    throw new Error(
      `RPC URL não configurada pra chain ${bp.cfg.name} (chainId=${chainId}). Verifique .env.`,
    );
  }

  const client = createPublicClient({
    chain: bp.viemChain,
    transport: http(bp.rpc),
  });

  let wallet: AnyWalletClient | undefined;
  let account: Address | undefined;

  // Só cria wallet se modo != dryrun E EXECUTOR_PRIVATE_KEY estiver setada
  if (env.LIQUIDATOR_MODE !== 'dryrun') {
    if (!env.EXECUTOR_PRIVATE_KEY) {
      throw new Error(
        `LIQUIDATOR_MODE=${env.LIQUIDATOR_MODE} exige EXECUTOR_PRIVATE_KEY definida no .env.`,
      );
    }
    const pkRaw = env.EXECUTOR_PRIVATE_KEY.startsWith('0x')
      ? env.EXECUTOR_PRIVATE_KEY
      : `0x${env.EXECUTOR_PRIVATE_KEY}`;
    const acct = privateKeyToAccount(pkRaw as `0x${string}`);
    account = acct.address;
    wallet = createWalletClient({
      account: acct,
      chain: bp.viemChain,
      transport: http(bp.rpc),
    });
  }

  return {
    chainConfig: bp.cfg,
    rpcUrl: bp.rpc,
    client,
    wallet,
    account,
    executorContractAddress: bp.executorAddr as Address | undefined,
    subgraphId: bp.subgraphId,
    isTestnet: bp.cfg.isTestnet ?? false,
  };
}

function resolveBlueprint(env: LiquidatorEnv, chainId: number): ChainBlueprint {
  switch (chainId) {
    case 8453:
      return {
        cfg: BASE_MAINNET,
        rpc: env.BASE_RPC_HTTP,
        subgraphId: env.AAVE_V3_BASE_SUBGRAPH_ID,
        viemChain: base,
        executorAddr: env.LIQUIDATOR_ADDRESS_BASE ?? env.LIQUIDATOR_ADDRESS ?? env.EXECUTOR_CONTRACT_ADDRESS_BASE,
      };
    case 84532:
      return {
        cfg: BASE_SEPOLIA,
        rpc: env.BASE_SEPOLIA_RPC_HTTP,
        subgraphId: env.AAVE_V3_BASE_SUBGRAPH_ID,
        viemChain: baseSepolia,
        executorAddr: env.LIQUIDATOR_ADDRESS_BASE_SEPOLIA
          ?? env.LIQUIDATOR_ADDRESS
          ?? env.EXECUTOR_CONTRACT_ADDRESS_BASE_SEPOLIA
          ?? env.EXECUTOR_CONTRACT_ADDRESS,
      };
    case 42161:
      return {
        cfg: ARBITRUM_MAINNET,
        rpc: env.ARBITRUM_RPC_HTTP,
        subgraphId: env.AAVE_V3_ARBITRUM_SUBGRAPH_ID,
        viemChain: arbitrum,
        executorAddr: env.LIQUIDATOR_ADDRESS_ARBITRUM ?? env.LIQUIDATOR_ADDRESS ?? env.EXECUTOR_CONTRACT_ADDRESS_ARBITRUM,
      };
    case 421614:
      return {
        cfg: ARBITRUM_SEPOLIA,
        rpc: env.ARBITRUM_SEPOLIA_RPC_HTTP,
        subgraphId: env.AAVE_V3_ARBITRUM_SUBGRAPH_ID,
        viemChain: arbitrumSepolia,
        executorAddr: env.LIQUIDATOR_ADDRESS_ARBITRUM_SEPOLIA ?? env.LIQUIDATOR_ADDRESS ?? env.EXECUTOR_CONTRACT_ADDRESS_ARBITRUM_SEPOLIA,
      };
    case 10:
      return {
        cfg: OPTIMISM_MAINNET,
        rpc: env.OPTIMISM_RPC_HTTP,
        subgraphId: env.AAVE_V3_OPTIMISM_SUBGRAPH_ID,
        viemChain: optimism,
        executorAddr: env.LIQUIDATOR_ADDRESS_OPTIMISM ?? env.LIQUIDATOR_ADDRESS ?? env.EXECUTOR_CONTRACT_ADDRESS_OPTIMISM,
      };
    case 11155420:
      return {
        cfg: OPTIMISM_SEPOLIA,
        rpc: env.OPTIMISM_SEPOLIA_RPC_HTTP,
        subgraphId: env.AAVE_V3_OPTIMISM_SUBGRAPH_ID,
        viemChain: optimismSepolia,
        executorAddr: env.LIQUIDATOR_ADDRESS_OPTIMISM_SEPOLIA ?? env.LIQUIDATOR_ADDRESS ?? env.EXECUTOR_CONTRACT_ADDRESS_OPTIMISM_SEPOLIA,
      };
    case 137:
      return {
        cfg: POLYGON_MAINNET,
        rpc: env.POLYGON_RPC_HTTP,
        subgraphId: env.AAVE_V3_POLYGON_SUBGRAPH_ID,
        viemChain: polygon,
        executorAddr: env.LIQUIDATOR_ADDRESS_POLYGON ?? env.LIQUIDATOR_ADDRESS ?? env.EXECUTOR_CONTRACT_ADDRESS_POLYGON,
      };
    default:
      throw new Error(
        `CHAIN_ID=${chainId} não suportado. Use: 8453/42161/10/137 (mainnet) ou 84532/421614/11155420 (sepolia).`,
      );
  }
}
