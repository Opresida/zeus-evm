/**
 * Backtest — replay histórico de N blocos Base mainnet pra identificar
 * oportunidades cross-DEX que existiram on-chain.
 *
 * Pra cada bloco no range:
 *   1. Pra cada par alvo, roda findCrossDexArb com state fixo no bloco
 *   2. Acumula TODAS as oportunidades (não filtra por min profit — queremos
 *      ver a distribuição completa)
 *   3. Output JSON + log das top N oportunidades
 *
 * Importante: usa `blockNumber` em todas as RPC calls, então a leitura é
 * deterministica pra aquele snapshot. Requer archive node (dRPC free OK).
 *
 * Uso:
 *   START_BLOCK=46300000 NUM_BLOCKS=100 STEP=10 pnpm --filter @zeus-evm/backtest start
 */

import 'dotenv/config';
import { createPublicClient, http, parseUnits, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import pino from 'pino';

import { BASE_TARGET_PAIRS, type TargetPair } from '@zeus-evm/chain-config';
import { findCrossDexArb, type CrossDexOpportunity } from '@zeus-evm/strategy';

// Carrega .env da raiz do monorepo
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../../../.env') });

type AnyPublicClient = PublicClient<any, any>;

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'zeus-evm-backtest' },
  transport: process.env.NODE_ENV === 'production' ? undefined : {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss.l' },
  },
});

const TEST_AMOUNT_USD = 1_000;

interface BacktestConfig {
  startBlock: bigint;
  numBlocks: number;
  step: number; // pular blocos (1 = todos; 10 = a cada 10)
}

interface ScanResult {
  blockNumber: bigint;
  opportunities: CrossDexOpportunity[];
  durationMs: number;
}

function getAmountInForPair(pair: TargetPair): bigint {
  const amountInTokens = TEST_AMOUNT_USD / pair.estimatedUsdValueA;
  return parseUnits(amountInTokens.toFixed(Math.min(pair.decimalsA, 18)), pair.decimalsA);
}

/**
 * Roda findCrossDexArb em paralelo pra todos os pares num bloco específico.
 */
async function scanBlock(
  client: AnyPublicClient,
  blockNumber: bigint,
): Promise<ScanResult> {
  const start = Date.now();

  const results = await Promise.allSettled(
    BASE_TARGET_PAIRS.map((pair) =>
      findCrossDexArb({
        client,
        pair,
        amountInA: getAmountInForPair(pair),
        blockNumber,
      }),
    ),
  );

  const opportunities: CrossDexOpportunity[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      opportunities.push(r.value);
    }
  }

  return { blockNumber, opportunities, durationMs: Date.now() - start };
}

function parseConfig(): BacktestConfig {
  const numBlocks = parseInt(process.env.NUM_BLOCKS ?? '100', 10);
  const step = parseInt(process.env.STEP ?? '1', 10);
  const startBlockEnv = process.env.START_BLOCK;

  return {
    startBlock: startBlockEnv ? BigInt(startBlockEnv) : 0n, // 0 = head - numBlocks*step
    numBlocks,
    step,
  };
}

async function main() {
  const rpcUrl = process.env.BASE_RPC_HTTP;
  if (!rpcUrl) throw new Error('BASE_RPC_HTTP não definido no .env');

  const config = parseConfig();

  const client: AnyPublicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  // Se startBlock=0, usa head - numBlocks*step pra olhar pro passado recente
  let startBlock = config.startBlock;
  if (startBlock === 0n) {
    const head = await client.getBlockNumber();
    startBlock = head - BigInt(config.numBlocks * config.step);
  }

  const endBlock = startBlock + BigInt(config.numBlocks * config.step);

  logger.info(
    {
      startBlock: startBlock.toString(),
      endBlock: endBlock.toString(),
      numBlocks: config.numBlocks,
      step: config.step,
      pairs: BASE_TARGET_PAIRS.length,
    },
    `🚀 Backtest iniciado — escaneando ${config.numBlocks} blocos (step=${config.step})`,
  );

  const allOpportunities: CrossDexOpportunity[] = [];
  let blocksScanned = 0;
  let totalDurationMs = 0;

  for (let i = 0; i < config.numBlocks; i++) {
    const block = startBlock + BigInt(i * config.step);

    try {
      const result = await scanBlock(client, block);
      blocksScanned++;
      totalDurationMs += result.durationMs;
      allOpportunities.push(...result.opportunities);

      if (result.opportunities.length > 0) {
        const best = result.opportunities.reduce((a, b) => (a.profitWei > b.profitWei ? a : b));
        logger.info(
          {
            block: block.toString(),
            count: result.opportunities.length,
            bestProfitUsd: best.profitUsd.toFixed(4),
            bestPair: best.pair.id,
            bestBuy: best.buyQuote.source,
            bestSell: best.sellQuote.source,
            bestProfitBps: best.profitBps,
            durationMs: result.durationMs,
          },
          `📊 [${i + 1}/${config.numBlocks}] block ${block} → ${result.opportunities.length} opp, best=${best.pair.id} +$${best.profitUsd.toFixed(2)}`,
        );
      } else if ((i + 1) % 10 === 0) {
        logger.info(
          {
            block: block.toString(),
            progress: `${i + 1}/${config.numBlocks}`,
          },
          `⏳ [${i + 1}/${config.numBlocks}] block ${block} → 0 opp`,
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, block: block.toString() },
        `scan block failed`,
      );
    }
  }

  // ─── Análise ───
  const sorted = [...allOpportunities].sort((a, b) => Number(b.profitWei - a.profitWei));
  const top10 = sorted.slice(0, 10);

  logger.info(
    {
      blocksScanned,
      totalOpportunities: allOpportunities.length,
      avgDurationPerBlock: blocksScanned > 0 ? (totalDurationMs / blocksScanned).toFixed(0) : 0,
      totalDurationSec: (totalDurationMs / 1000).toFixed(1),
    },
    `✅ Backtest concluído`,
  );

  if (top10.length === 0) {
    logger.warn('⚠️  Nenhuma oportunidade cross-DEX detectada no range. Tente expandir NUM_BLOCKS.');
  } else {
    logger.info('🏆 TOP 10 oportunidades:');
    for (let i = 0; i < top10.length; i++) {
      const opp = top10[i]!;
      logger.info(
        {
          rank: i + 1,
          block: opp.blockNumber.toString(),
          pair: opp.pair.id,
          buy: opp.buyQuote.source,
          sell: opp.sellQuote.source,
          profitUsd: opp.profitUsd.toFixed(4),
          profitBps: opp.profitBps,
          amountInWei: opp.amountIn.toString(),
        },
        `  #${i + 1} block ${opp.blockNumber} ${opp.pair.id} buy@${opp.buyQuote.source} sell@${opp.sellQuote.source} +$${opp.profitUsd.toFixed(2)} (${opp.profitBps}bps)`,
      );
    }
  }

  // ─── Salvar JSON ───
  const outputPath = resolve(__dirname, '../runs', `backtest-${Date.now()}.json`);
  const serializable = {
    config: {
      startBlock: startBlock.toString(),
      endBlock: endBlock.toString(),
      numBlocks: config.numBlocks,
      step: config.step,
    },
    stats: {
      blocksScanned,
      totalOpportunities: allOpportunities.length,
      avgDurationPerBlockMs: blocksScanned > 0 ? totalDurationMs / blocksScanned : 0,
    },
    opportunities: sorted.map((opp) => ({
      blockNumber: opp.blockNumber.toString(),
      pair: opp.pair.id,
      direction: opp.direction,
      buy: opp.buyQuote.source,
      sell: opp.sellQuote.source,
      amountIn: opp.amountIn.toString(),
      amountOut: opp.amountOut.toString(),
      profitWei: opp.profitWei.toString(),
      profitBps: opp.profitBps,
      profitUsd: opp.profitUsd,
      detectedAt: opp.detectedAt,
    })),
  };

  await writeFile(outputPath, JSON.stringify(serializable, null, 2));
  logger.info({ outputPath }, `💾 Resultados salvos em ${outputPath}`);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, '🔴 Backtest crashed');
  process.exit(1);
});
