/**
 * MIS Scanner — varredura de ineficiências de mercado (Motor 2).
 *
 * Padrão de uso atual (sem VM 24/7): rodar ao chegar, deixar varrendo até sair.
 * O histórico é PERSISTIDO em disco (snapshot JSON) — ao reiniciar amanhã, recarrega
 * e continua acumulando. A persistência (sinal-chave do MIS) cresce dia após dia.
 *
 * Próximo passo: deploy 24/7 na Fly.io.
 *
 * Roda em OBSERVAÇÃO PURA — sem capital, sem submeter tx. Só lê estado on-chain,
 * calcula divergências locais e ranqueia por persistência.
 *
 *   pnpm --filter @zeus-evm/mis-scanner start
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import dotenv from 'dotenv';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import pino from 'pino';

import { BASE_MAINNET } from '@zeus-evm/chain-config';
import { MarketInefficiencyScanner, type InefficiencyObservation } from '@zeus-evm/execution-utils';
import { BASE_CURATED_PAIRS, curatedPairsToResolved, dedupPairs, resolvePoolGroups, type ResolvedPair } from './poolGroups';
import { deriveProtocolTokens, buildDerivedPairs } from './deriveTokens';
import { optimizeFlashLoan, fetchEthUsd } from './flashEstimator';

// Carrega .env local + raiz do monorepo (2 níveis acima) — RPC fica na raiz
dotenv.config();
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env') });

const logger = pino({ transport: { target: 'pino-pretty' } });

const RPC = process.env.BASE_RPC_HTTP;
const SCAN_INTERVAL_MS = Number(process.env.MIS_SCAN_INTERVAL_MS ?? 12_000); // ~1 bloco Base
const SNAPSHOT_DIR = resolve(process.cwd(), 'logs', 'mis');
const SNAPSHOT_PATH = resolve(SNAPSHOT_DIR, 'base-mis-snapshot.json');
const RANKING_EVERY = Number(process.env.MIS_RANKING_EVERY ?? 25); // loga ranking a cada N scans

function loadSnapshot(): Record<string, InefficiencyObservation[]> | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'snapshot corrompido — começando vazio');
    return null;
  }
}

function saveSnapshot(data: Record<string, InefficiencyObservation[]>): void {
  try {
    if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(data), 'utf-8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'erro salvando snapshot');
  }
}

async function main(): Promise<void> {
  if (!RPC) {
    logger.fatal('BASE_RPC_HTTP não definido no .env — MIS precisa de RPC pra ler pools');
    process.exit(1);
  }

  const client = createPublicClient({ chain: base, transport: http(RPC) });

  // MIS com window de 7 dias (persistência precisa de tempo) + snapshot a cada sample
  const minDivergenceBps = Number(process.env.MIS_MIN_DIVERGENCE_BPS ?? 20);
  const mis = new MarketInefficiencyScanner({
    minDivergenceBps,
    windowMs: 7 * 24 * 60 * 60 * 1000,
  });

  // Recarrega histórico acumulado (padrão liga/desliga)
  const prev = loadSnapshot();
  if (prev) {
    mis.restore(prev);
    logger.info({ samples: mis.stats().totalSamples }, '📂 histórico anterior recarregado');
  }

  // Monta o universo de pares: curados (tese) + derivados on-chain (colaterais lending)
  const curated = curatedPairsToResolved(BASE_CURATED_PAIRS, BASE_MAINNET);
  let allPairs: ResolvedPair[] = curated;

  const deriveTokens = (process.env.MIS_DERIVE_TOKENS ?? 'true') !== 'false';
  if (deriveTokens) {
    logger.info('🧬 derivando tokens dos colaterais Aave/Moonwell/Morpho...');
    const tokens = await deriveProtocolTokens({
      client,
      chainConfig: BASE_MAINNET,
      logger,
      opts: {
        includeMorpho: (process.env.MIS_DERIVE_MORPHO ?? 'true') !== 'false',
        maxPairs: Number(process.env.MIS_MAX_DERIVED_PAIRS ?? 60),
      },
    });
    const derived = buildDerivedPairs({
      tokens,
      chainConfig: BASE_MAINNET,
      opts: { maxPairs: Number(process.env.MIS_MAX_DERIVED_PAIRS ?? 60) },
    });
    logger.info({ tokens: tokens.length, derivedPairs: derived.length }, `🧬 ${tokens.length} tokens → ${derived.length} pares derivados`);
    // Curados primeiro (prioridade no dedup), depois derivados
    allPairs = dedupPairs([...curated, ...derived]);
  }

  // Resolve pools on-chain de todos os pares (curados + derivados)
  logger.info({ pairs: allPairs.length }, '🔍 resolvendo pools on-chain...');
  const groups = await resolvePoolGroups({ client, chainConfig: BASE_MAINNET, pairs: allPairs, logger });
  for (const g of groups) mis.registerGroup(g);

  if (mis.groupCount() === 0) {
    logger.fatal('Nenhum grupo resolvido — verifique RPC/factory. Abortando.');
    process.exit(1);
  }
  logger.info({ groups: mis.groupCount() }, `✅ MIS pronto — varrendo ${mis.groupCount()} grupos a cada ${SCAN_INTERVAL_MS}ms`);

  // Lookup grupo por label (pro estimador de flash usar tokens/pools reais)
  const groupByLabel = new Map(groups.map((g) => [g.label, g]));
  // Só estima flash em divergência forte o suficiente pra valer o RPC (default = minDiv)
  const flashMinBps = Number(process.env.MIS_FLASH_MIN_BPS ?? minDivergenceBps);
  // Budget de slippage do gate de profundidade: round-trip < (1−budget) = pool raso
  const maxSlippageBps = Number(process.env.MIS_MAX_SLIPPAGE_BPS ?? 500);

  // Graceful shutdown: salva snapshot ao sair (Ctrl+C)
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    saveSnapshot(mis.snapshot());
    logger.info({ samples: mis.stats().totalSamples }, '💾 snapshot salvo — até a próxima varredura');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let scanCount = 0;
  const tick = async () => {
    if (stopping) return;
    try {
      const obs = await mis.scanAllBatched(client);
      scanCount++;
      const active = obs.filter((o) => o.maxDivergenceBps >= minDivergenceBps);
      if (active.length > 0) {
        logger.info(
          { divergences: active.map((o) => `${o.groupLabel}=${o.maxDivergenceBps}bps`) },
          `📡 scan #${scanCount}: ${active.length} grupos com divergência ativa`,
        );

        // Enriquece com dados do flash (quoter on-chain) só pras divergências fortes
        const strong = active.filter((o) => o.maxDivergenceBps >= flashMinBps && groupByLabel.has(o.groupLabel));
        const ethUsd = strong.length > 0 ? await fetchEthUsd(client, BASE_MAINNET) : 0; // cotado 1x/tick
        for (const o of strong) {
          const group = groupByLabel.get(o.groupLabel)!;
          try {
            // Acha o TAMANHO ÓTIMO do empréstimo (pico de lucro antes do slippage matar)
            const opt = await optimizeFlashLoan({
              client, chainConfig: BASE_MAINNET, group, observation: o,
              opts: { ethUsd, maxSlippageBps },
            });
            // Sem tamanho viável (mesmo o menor não lucra / pool raso) → fora do ranking
            const viable = opt.best !== null && opt.maxViableLoanUsd > 0;
            mis.markThin(o.groupLabel, !viable);

            if (!viable) {
              const rt = opt.curve[0]?.roundTripRatio ?? 0;
              logger.info(
                { par: o.groupLabel, divBps: o.maxDivergenceBps, melhorRoundTrip: `${(rt * 100).toFixed(1)}%`, curva: opt.curve },
                `🕳️ ${o.groupLabel} INVIÁVEL: nenhum tamanho de empréstimo fecha com lucro — fora do ranking`,
              );
              continue;
            }

            const b = opt.best!;
            logger.info(
              {
                par: b.pair,
                hora: b.isoTime,
                rota: `${b.cheapPool} → ${b.expensivePool}`,
                divBps: b.divergenceBps,
                emprestimoOtimo: `$${b.loanUsd} (${b.loanTokenB})`,
                tetoViavel: `$${opt.maxViableLoanUsd}`,
                devolucaoAave: `$${b.repayUsd.toFixed(2)} (${b.repayTokenB})`,
                gasCusto: `$${b.gasCostUsd}`,
                lucroLiquido: `$${b.netProfitUsd}`,
                lucroPct: `${b.profitPct}%`,
                roundTrip: `${(b.roundTripRatio * 100).toFixed(1)}%`,
                curva: opt.curve.map((c) => `$${c.loanUsd}→$${c.netProfitUsd}`),
              },
              `💰 ${b.pair}: ótimo $${b.loanUsd} → líquido $${b.netProfitUsd} (${b.profitPct}%) · teto viável $${opt.maxViableLoanUsd}`,
            );
          } catch (err) {
            logger.debug?.({ par: o.groupLabel, err: err instanceof Error ? err.message : err }, 'otimização de flash falhou');
          }
        }
      }
      saveSnapshot(mis.snapshot());

      if (scanCount % RANKING_EVERY === 0) {
        const ranking = mis.ranking().slice(0, 10);
        logger.info(
          {
            ranking: ranking.map((r) => ({ par: r.groupLabel, score: r.score, persist: `${(r.persistenceRatio * 100).toFixed(0)}%`, avgBps: r.avgDivergenceBps, n: r.samples })),
            rasosExcluidos: mis.thinCount(),
          },
          `🏆 Ranking de ineficiência persistente (top ${ranking.length}, ${mis.thinCount()} rasos fora)`,
        );
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'scan falhou (continua)');
    }
  };

  await tick();
  // SEM unref: o scanner deve varrer continuamente até SIGINT (padrão "deixa varrendo").
  setInterval(() => void tick(), SCAN_INTERVAL_MS);
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, 'MIS scanner crashou');
  process.exit(1);
});
