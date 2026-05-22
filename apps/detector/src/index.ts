/**
 * ZEUS EVM — Detector entrypoint.
 *
 * STATUS: STUB inicial. Implementação real virá nas Fases 2-3.
 *
 * Responsabilidades:
 *   1. Conectar RPC (Alchemy primário, fallback público)
 *   2. Escutar mempool e novos blocos
 *   3. Identificar oportunidades de arbitragem (cross-DEX, triangular)
 *   4. Simular tx antes de enviar (eth_call)
 *   5. Submeter tx ao ZeusExecutor on-chain
 *   6. Reportar resultados (logs + Discord)
 *
 * Ver ARCHITECTURE.md para fluxo detalhado.
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { BASE_MAINNET } from '@zeus-evm/chain-config';

import { loadConfig } from './config';
import { logger } from './logger';

async function main() {
  const env = loadConfig();

  logger.info({ chain: BASE_MAINNET.name, chainId: BASE_MAINNET.chainId }, 'Detector boot');

  // ─── Validações iniciais ───
  if (env.KILL_SWITCH) {
    logger.warn('KILL_SWITCH ativo — bot não vai submeter transações');
  }

  if (!env.EXECUTOR_PRIVATE_KEY) {
    logger.warn('EXECUTOR_PRIVATE_KEY ausente — rodando em modo read-only');
  }

  // ─── Setup do client (read-only por enquanto) ───
  const publicClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_HTTP),
  });

  const blockNumber = await publicClient.getBlockNumber();
  logger.info({ blockNumber: blockNumber.toString() }, 'Conectado em Base mainnet');

  // ─── TODO Fase 2: mempool listener ───
  // ─── TODO Fase 2: opportunity detector ───
  // ─── TODO Fase 2: tx submitter ───

  logger.info('Detector inicializado. Aguardando implementação da Fase 2.');

  // Mantém o processo vivo até implementação real
  await new Promise(() => {});
}

main().catch((err) => {
  logger.error({ err }, 'Detector crashed at boot');
  process.exit(1);
});
