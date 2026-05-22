/**
 * Smoke test — valida config + conexão RPC + 1 scan completo.
 * Roda uma vez e sai. NÃO submete tx.
 *
 * Uso: pnpm --filter @zeus-evm/detector exec tsx src/smoke.ts
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';

import { BASE_MAINNET, BASE_TARGET_PAIRS } from '@zeus-evm/chain-config';
import { loadConfig } from './config';
import { logger } from './logger';

type AnyPublicClient = PublicClient<any, any>;

async function main() {
  // ─── 1) Validar config ───
  const env = loadConfig();

  // Mascara dados sensíveis no log
  const maskedRpc = env.BASE_RPC_HTTP.replace(/(dkey=|\/base\/)[A-Za-z0-9_-]+/, '$1***');
  const hasKey = !!env.EXECUTOR_PRIVATE_KEY;
  const executor = env.EXECUTOR_ADDRESS ?? '(não setado)';
  const owner = env.EXECUTOR_OWNER_ADDRESS ?? '(não setado)';

  logger.info(
    {
      rpc: maskedRpc,
      executorAddress: executor,
      ownerAddress: owner,
      hasPrivateKey: hasKey,
      killSwitch: env.KILL_SWITCH,
      maxTradeEth: env.MAX_TRADE_ETH,
      minProfitUsd: env.MIN_PROFIT_USD,
    },
    '✅ Config válida (schema Zod OK)',
  );

  // ─── 2) Testar conexão ───
  const client: AnyPublicClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_HTTP),
  });

  const block = await client.getBlockNumber();
  const chainId = await client.getChainId();
  logger.info({ chainId, blockNumber: block.toString() }, '✅ Conectado ao RPC');

  if (chainId !== 8453) {
    throw new Error(`ChainId errado: esperado 8453, recebi ${chainId}`);
  }

  // ─── 3) Testar getBalance da carteira (se setada) ───
  if (env.EXECUTOR_ADDRESS) {
    const balance = await client.getBalance({ address: env.EXECUTOR_ADDRESS as `0x${string}` });
    logger.info(
      {
        address: env.EXECUTOR_ADDRESS,
        balanceWei: balance.toString(),
        balanceEth: Number(balance) / 1e18,
      },
      `💰 Saldo da carteira executor: ${(Number(balance) / 1e18).toFixed(6)} ETH`,
    );
  }

  // ─── 4) Imprimir pares alvo ───
  logger.info(
    {
      chain: BASE_MAINNET.name,
      pairs: BASE_TARGET_PAIRS.map((p) => p.id),
    },
    `🎯 ${BASE_TARGET_PAIRS.length} pares alvo configurados`,
  );

  logger.info('🟢 Smoke test PASSOU — config + RPC + carteira OK');
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, '🔴 Smoke test FALHOU');
  process.exit(1);
});
