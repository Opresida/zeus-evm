/**
 * Block subscription via Alchemy WebSocket.
 *
 * Pra Fase 2 (DRY_RUN), o detector reage a NOVOS BLOCOS (não a pending txs).
 * Em cada novo bloco:
 *   - Re-scan oportunidades nos 5 pares alvo
 *   - Loga oportunidades detectadas (filtradas ou não)
 *
 * Mempool tx-pending listener fica pra Fase 2.5 (dislocation pos-trade) — exige
 * decoding de calldata + análise de impacto, mais complexo. Block-based já basta
 * pra validar a engine matemática.
 */

import { createPublicClient, webSocket, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { logger } from '../logger';

type AnyPublicClient = PublicClient<any, any>;

export interface BlockSubscriptionParams {
  wsUrl: string;
  /** Callback invocado a cada novo block — recebe block.number como bigint */
  onBlock: (blockNumber: bigint) => Promise<void>;
}

/**
 * Inicia subscription WSS. Retorna unsubscribe function.
 */
export function subscribeToBlocks(params: BlockSubscriptionParams): () => void {
  const { wsUrl, onBlock } = params;

  const wsClient: AnyPublicClient = createPublicClient({
    chain: base,
    transport: webSocket(wsUrl, {
      retryCount: 5,
      retryDelay: 1_500,
    }),
  });

  logger.info('Subscribing to Base mainnet blocks via WSS...');

  const unwatch = wsClient.watchBlocks({
    onBlock: async (block) => {
      if (block.number === null) return;
      try {
        await onBlock(block.number);
      } catch (err) {
        logger.error({ err, blockNumber: block.number?.toString() }, 'onBlock handler failed');
      }
    },
    onError: (err) => {
      logger.error({ err }, 'WSS block subscription error');
    },
  });

  return () => {
    logger.info('Unsubscribing from blocks');
    unwatch();
  };
}
