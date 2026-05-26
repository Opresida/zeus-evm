/**
 * Chain context — resolve client + wallet + executor address.
 *
 * Espelha o que liquidator faz. Como backrun por enquanto só roda em Base,
 * suportamos apenas chainId=8453. Multi-chain entra junto com expansão futura
 * (Arbitrum/Optimism) — quando comprovarmos edge no L2 primário.
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
import { base } from 'viem/chains';

import { BASE_MAINNET } from '@zeus-evm/chain-config';

import type { BackrunEnv, BackrunMode } from './config';
import { logger } from './logger';

type AnyPublicClient = PublicClient<any, any>;
type AnyWalletClient = WalletClient<any, any, any>;

export interface BackrunChainContext {
  chainName: string;
  chainId: number;
  client: AnyPublicClient;
  wallet?: AnyWalletClient;
  account?: Address;
  executorAddress?: Address;
  uniswapV3Quoter: Address;
  aerodromeRouter: Address;
  aerodromeFactory: Address;
  knownRouters: {
    uniswapV3SwapRouter02: Address;
    uniswapV3UniversalRouter: Address;
    aerodromeRouter: Address;
  };
}

export function buildChainContext(env: BackrunEnv): BackrunChainContext {
  if (env.CHAIN_ID !== BASE_MAINNET.chainId) {
    throw new Error(
      `[backrun-engine] CHAIN_ID=${env.CHAIN_ID} ainda não suportado — apenas Base (8453) por enquanto.`,
    );
  }

  if (!env.BASE_RPC_HTTP) {
    throw new Error('BASE_RPC_HTTP não configurado no .env');
  }

  const client: AnyPublicClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_HTTP),
  });

  let wallet: AnyWalletClient | undefined;
  let account: Address | undefined;
  if (env.EXECUTOR_PRIVATE_KEY && env.BACKRUN_MODE !== 'dryrun') {
    const accountObj = privateKeyToAccount(env.EXECUTOR_PRIVATE_KEY as `0x${string}`);
    account = accountObj.address;
    wallet = createWalletClient({
      account: accountObj,
      chain: base,
      transport: http(env.BASE_RPC_HTTP),
    });
    logger.info({ account, mode: env.BACKRUN_MODE }, '🔑 Wallet pronta');
  } else if (env.BACKRUN_MODE !== 'dryrun') {
    logger.warn(
      { mode: env.BACKRUN_MODE },
      '⚠️ Mode != dryrun mas EXECUTOR_PRIVATE_KEY não setado — wallet OMITIDA',
    );
  }

  // V8: prioridade pra ARB_EXECUTOR_ADDRESS_* (ZeusArbExecutor split).
  // Fallback: EXECUTOR_CONTRACT_ADDRESS_* (contrato monolítico pre-v8).
  const executorAddress =
    (env.ARB_EXECUTOR_ADDRESS_BASE as Address | undefined) ??
    (env.ARB_EXECUTOR_ADDRESS as Address | undefined) ??
    (env.EXECUTOR_CONTRACT_ADDRESS_BASE as Address | undefined) ??
    (env.EXECUTOR_CONTRACT_ADDRESS as Address | undefined);

  return {
    chainName: BASE_MAINNET.name,
    chainId: BASE_MAINNET.chainId,
    client,
    wallet,
    account,
    executorAddress,
    uniswapV3Quoter: BASE_MAINNET.uniswapV3.quoterV2,
    aerodromeRouter: BASE_MAINNET.aerodrome!.router,
    aerodromeFactory: BASE_MAINNET.aerodrome!.factory,
    knownRouters: {
      uniswapV3SwapRouter02: BASE_MAINNET.uniswapV3.swapRouter02,
      uniswapV3UniversalRouter:
        BASE_MAINNET.uniswapV3.universalRouter ?? BASE_MAINNET.uniswapV3.swapRouter02,
      aerodromeRouter: BASE_MAINNET.aerodrome!.router,
    },
  };
}

export function modeFromEnv(env: BackrunEnv): BackrunMode {
  return env.BACKRUN_MODE;
}
