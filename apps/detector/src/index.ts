/**
 * ZEUS EVM — Detector entrypoint.
 *
 * Fase 2 — DRY_RUN mode:
 *   1. Conecta na Base via HTTP + WSS
 *   2. A cada novo bloco, escaneia 5 pares alvo
 *   3. Pra cada par, busca oportunidade cross-DEX (UniV3 vs Aerodrome)
 *   4. Filtra por min profit, slippage, gas
 *   5. Loga oportunidades em JSON estruturado (pino)
 *
 * NÃO submete tx. NÃO precisa de private key. Modo observacional puro.
 */

import { createPublicClient, http, parseUnits, type PublicClient } from 'viem';
import { base } from 'viem/chains';

import { BASE_MAINNET, BASE_TARGET_PAIRS, type TargetPair } from '@zeus-evm/chain-config';
import {
  findCrossDexArb,
  filterOpportunity,
  type FilterCriteria,
} from './opportunities';
import { subscribeToBlocks } from './mempool/blockSubscription';
import { loadConfig } from './config';
import { logger } from './logger';

type AnyPublicClient = PublicClient<any, any>;

// ─── Tamanho de teste por par (em USD aproximado) ───
// Pra Fase 2 DRY_RUN, testamos com $1.000 por par — size suficiente pra ter
// oportunidades não-triviais sem gastar todas as quotes em chamadas pequenas.
const TEST_AMOUNT_USD = 1_000;

/**
 * Calcula amountIn em wei do tokenA equivalente a TEST_AMOUNT_USD.
 */
function getAmountInForPair(pair: TargetPair): bigint {
  const amountInTokens = TEST_AMOUNT_USD / pair.estimatedUsdValueA;
  return parseUnits(amountInTokens.toFixed(Math.min(pair.decimalsA, 18)), pair.decimalsA);
}

/**
 * Critérios base de filtragem (maxTradeWei adicionado por par).
 */
function buildFilterCriteria(minProfitUsd: number, maxSlippageBps: number): Omit<FilterCriteria, 'maxTradeWei'> {
  return {
    minProfitUsd,
    maxSlippageBps,
    estimatedGasUsd: 0.5,  // Base é cheap (~$0.10-1.00 por tx)
    flashloanFeeBps: 0,    // Modalidade wallet por enquanto. 5 quando ativar flashloan
  };
}

/**
 * Scan completo: itera 5 pares, busca arb, aplica filtros, loga.
 */
async function scanPairs(
  client: AnyPublicClient,
  blockNumber: bigint,
  filterCriteria: Omit<FilterCriteria, 'maxTradeWei'>,
): Promise<{ scanned: number; detected: number; filtered: number }> {
  let detected = 0;
  let filtered = 0;

  for (const pair of BASE_TARGET_PAIRS) {
    const amountInA = getAmountInForPair(pair);
    const maxTradeWei = amountInA * 10n; // cap em 10x o amount testado

    try {
      const opp = await findCrossDexArb({
        client,
        pair,
        amountInA,
        blockNumber,
      });

      if (!opp) continue;
      detected++;

      const result = filterOpportunity(opp, { ...filterCriteria, maxTradeWei });

      if (result.passed) {
        filtered++;
        logger.info(
          {
            event: 'opportunity_filtered',
            pair: pair.id,
            buy: opp.buyQuote.source,
            sell: opp.sellQuote.source,
            amountIn: opp.amountIn.toString(),
            profitWei: opp.profitWei.toString(),
            profitBps: opp.profitBps,
            profitUsd: opp.profitUsd.toFixed(4),
            netProfitUsd: result.netProfitUsd?.toFixed(4),
            blockNumber: blockNumber.toString(),
          },
          `💰 OPORTUNIDADE: ${pair.id} buy@${opp.buyQuote.source} sell@${opp.sellQuote.source} +$${result.netProfitUsd?.toFixed(2)}`,
        );
      } else {
        logger.debug(
          {
            event: 'opportunity_rejected',
            pair: pair.id,
            profitBps: opp.profitBps,
            profitUsd: opp.profitUsd.toFixed(4),
            reason: result.reason,
          },
          `rejeitada: ${pair.id} (${result.reason})`,
        );
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, pair: pair.id }, 'scan pair failed');
    }
  }

  return { scanned: BASE_TARGET_PAIRS.length, detected, filtered };
}

async function main() {
  const env = loadConfig();

  logger.info(
    {
      chain: BASE_MAINNET.name,
      chainId: BASE_MAINNET.chainId,
      targetPairs: BASE_TARGET_PAIRS.length,
      mode: 'DRY_RUN',
    },
    '🚀 Detector boot',
  );

  if (env.KILL_SWITCH) {
    logger.warn('KILL_SWITCH ativo — bot NÃO submeterá transações (esperado em Fase 2)');
  }

  // ─── Setup client HTTP ───
  const publicClient: AnyPublicClient = createPublicClient({
    chain: base,
    transport: http(env.BASE_RPC_HTTP),
  });

  const blockNumber = await publicClient.getBlockNumber();
  logger.info({ blockNumber: blockNumber.toString() }, '✅ Conectado em Base mainnet');

  const filterCriteria = buildFilterCriteria(env.MIN_PROFIT_USD, env.MAX_SLIPPAGE_BPS);

  // ─── Scan inicial ───
  logger.info('Executando scan inicial nos 5 pares alvo...');
  const initial = await scanPairs(publicClient, blockNumber, filterCriteria);
  logger.info(
    { ...initial, blockNumber: blockNumber.toString() },
    `✅ Scan inicial: ${initial.scanned} pares, ${initial.detected} oportunidades brutas, ${initial.filtered} filtradas`,
  );

  // ─── Subscribe a novos blocos ───
  if (!env.BASE_RPC_WS) {
    logger.warn('BASE_RPC_WS não configurado — rodando em polling. Definir .env pra subscribe via WSS.');
    setInterval(async () => {
      try {
        const block = await publicClient.getBlockNumber();
        const stats = await scanPairs(publicClient, block, filterCriteria);
        if (stats.detected > 0) {
          logger.info({ ...stats, blockNumber: block.toString() }, `[poll] scan`);
        }
      } catch (err) {
        logger.error({ err }, 'polling iteration failed');
      }
    }, 5_000);
  } else {
    subscribeToBlocks({
      wsUrl: env.BASE_RPC_WS,
      onBlock: async (block) => {
        const stats = await scanPairs(publicClient, block, filterCriteria);
        if (stats.detected > 0 || stats.filtered > 0) {
          logger.info({ ...stats, blockNumber: block.toString() }, `[block ${block}] scan`);
        }
      },
    });
  }

  await new Promise(() => {});
}

main().catch((err) => {
  logger.error({ err }, 'Detector crashed at boot');
  process.exit(1);
});
