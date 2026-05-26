/**
 * Chain context — resolve client + wallet + executor address + DEX adapters.
 *
 * V8 multi-chain: suporta Base mainnet/sepolia + Optimism mainnet.
 * Aerodrome (Base) e Velodrome (Optimism) compartilham mesmo adapter (mesmo ABI).
 *
 * Sub-task F1.7: RPC fallback transport (Alchemy primary + dRPC backup).
 * Quando Alchemy cair, viem automaticamente tenta o próximo transport.
 */

import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia, optimism } from 'viem/chains';

import { BASE_MAINNET, BASE_SEPOLIA, OPTIMISM_MAINNET, type ChainConfig } from '@zeus-evm/chain-config';

import type { BackrunEnv, BackrunMode } from './config';
import { logger } from './logger';

type AnyPublicClient = PublicClient<any, any>;
type AnyWalletClient = WalletClient<any, any, any>;

export interface BackrunChainContext {
  chainName: string;
  chainId: number;
  chainConfig: ChainConfig;
  client: AnyPublicClient;
  wallet?: AnyWalletClient;
  account?: Address;
  executorAddress?: Address;
  uniswapV3Quoter: Address;
  /** Secondary DEX (Aerodrome em Base, Velodrome em OP — mesmo ABI). */
  velodromeStyleRouter: Address;
  velodromeStyleFactory: Address;
  knownRouters: {
    uniswapV3SwapRouter02: Address;
    uniswapV3UniversalRouter: Address;
    velodromeStyleRouter: Address;
  };
}

interface ChainBlueprint {
  cfg: ChainConfig;
  viemChain: any;
  rpcPrimary: string | undefined;
  rpcFallback: string | undefined;
  executorAddr: string | undefined;
  /** Aerodrome (Base) ou Velodrome (OP) — mesma interface. */
  veloRouter: Address;
  veloFactory: Address;
}

function resolveBlueprint(env: BackrunEnv): ChainBlueprint {
  const chainId = env.CHAIN_ID;
  switch (chainId) {
    case 8453: {
      if (!BASE_MAINNET.aerodrome) {
        throw new Error('Base mainnet sem aerodrome config — bug interno');
      }
      return {
        cfg: BASE_MAINNET,
        viemChain: base,
        rpcPrimary: env.BASE_RPC_HTTP,
        rpcFallback: env.BASE_RPC_HTTP_FALLBACK,
        executorAddr:
          env.ARB_EXECUTOR_ADDRESS_BASE
          ?? env.ARB_EXECUTOR_ADDRESS
          ?? env.EXECUTOR_CONTRACT_ADDRESS_BASE
          ?? env.EXECUTOR_CONTRACT_ADDRESS,
        veloRouter: BASE_MAINNET.aerodrome.router,
        veloFactory: BASE_MAINNET.aerodrome.factory,
      };
    }
    case 84532: {
      // Base Sepolia — Aerodrome não tem deploy testnet oficial. Backrun em testnet
      // serve só pra smoke do pipeline (planner provavelmente retorna null sem pools reais).
      if (!BASE_SEPOLIA.aerodrome) {
        throw new Error('Base Sepolia sem aerodrome config — placeholder esperado');
      }
      return {
        cfg: BASE_SEPOLIA,
        viemChain: baseSepolia,
        rpcPrimary: env.BASE_SEPOLIA_RPC_HTTP,
        rpcFallback: env.BASE_SEPOLIA_RPC_HTTP_FALLBACK,
        executorAddr:
          env.ARB_EXECUTOR_ADDRESS_BASE_SEPOLIA
          ?? env.ARB_EXECUTOR_ADDRESS
          ?? env.EXECUTOR_CONTRACT_ADDRESS,
        veloRouter: BASE_SEPOLIA.aerodrome.router,
        veloFactory: BASE_SEPOLIA.aerodrome.factory,
      };
    }
    case 10: {
      if (!OPTIMISM_MAINNET.velodrome) {
        throw new Error('Optimism mainnet sem velodrome config — bug interno');
      }
      return {
        cfg: OPTIMISM_MAINNET,
        viemChain: optimism,
        rpcPrimary: env.OPTIMISM_RPC_HTTP,
        rpcFallback: env.OPTIMISM_RPC_HTTP_FALLBACK,
        executorAddr:
          env.ARB_EXECUTOR_ADDRESS_OPTIMISM
          ?? env.ARB_EXECUTOR_ADDRESS
          ?? env.EXECUTOR_CONTRACT_ADDRESS,
        veloRouter: OPTIMISM_MAINNET.velodrome.router,
        veloFactory: OPTIMISM_MAINNET.velodrome.factory,
      };
    }
    default:
      throw new Error(
        `[backrun-engine] CHAIN_ID=${chainId} não suportado. Use 8453 (Base), 84532 (Base Sepolia) ou 10 (Optimism).`,
      );
  }
}

export function buildChainContext(env: BackrunEnv): BackrunChainContext {
  const bp = resolveBlueprint(env);

  if (!bp.rpcPrimary) {
    throw new Error(`RPC primary não configurado pra ${bp.cfg.name} (chainId=${env.CHAIN_ID})`);
  }

  // Sub-task F1.7: RPC fallback. Se fallback URL configurado, usa `fallback([primary, fallback])`.
  // Viem detecta falha do primário e fallback automaticamente. Custo zero, resiliência alta.
  const transports = bp.rpcFallback
    ? fallback([http(bp.rpcPrimary), http(bp.rpcFallback)], { retryCount: 1 })
    : http(bp.rpcPrimary);

  const client: AnyPublicClient = createPublicClient({
    chain: bp.viemChain,
    transport: transports,
  });

  let wallet: AnyWalletClient | undefined;
  let account: Address | undefined;
  if (env.EXECUTOR_PRIVATE_KEY && env.BACKRUN_MODE !== 'dryrun') {
    const accountObj = privateKeyToAccount(env.EXECUTOR_PRIVATE_KEY as `0x${string}`);
    account = accountObj.address;
    wallet = createWalletClient({
      account: accountObj,
      chain: bp.viemChain,
      transport: transports,
    });
    logger.info(
      { account, mode: env.BACKRUN_MODE, chain: bp.cfg.name },
      '🔑 Wallet pronta',
    );
  } else if (env.BACKRUN_MODE !== 'dryrun') {
    logger.warn(
      { mode: env.BACKRUN_MODE },
      '⚠️ Mode != dryrun mas EXECUTOR_PRIVATE_KEY não setado — wallet OMITIDA',
    );
  }

  return {
    chainName: bp.cfg.name,
    chainId: bp.cfg.chainId,
    chainConfig: bp.cfg,
    client,
    wallet,
    account,
    executorAddress: bp.executorAddr as Address | undefined,
    uniswapV3Quoter: bp.cfg.uniswapV3.quoterV2,
    velodromeStyleRouter: bp.veloRouter,
    velodromeStyleFactory: bp.veloFactory,
    knownRouters: {
      uniswapV3SwapRouter02: bp.cfg.uniswapV3.swapRouter02,
      uniswapV3UniversalRouter:
        bp.cfg.uniswapV3.universalRouter ?? bp.cfg.uniswapV3.swapRouter02,
      velodromeStyleRouter: bp.veloRouter,
    },
  };
}

export function modeFromEnv(env: BackrunEnv): BackrunMode {
  return env.BACKRUN_MODE;
}
