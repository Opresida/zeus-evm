/**
 * Backtest histórico — replay dos reports JSON pra validar se candidates
 * auto-promovidos seguiram performando ao longo do tempo.
 *
 * ⚠️ LIMITAÇÃO HONESTA: backtest 100% preciso de backrun exige histórico
 * de mempool real (quais whales houve, se backrun teria ganho race). Sem isso,
 * fazemos uma APROXIMAÇÃO HEURÍSTICA:
 *
 *   1. Pra cada par no auto-targets atual, lê histórico de scores nos
 *      reports/<ISO>.json passados
 *   2. Calcula:
 *      - Score médio histórico
 *      - Volatilidade do score (DP)
 *      - Tendência (crescente / decrescente / estável)
 *      - Volume médio histórico
 *      - Fragmentação média
 *   3. Sinais positivos:
 *      - Score consistente acima de 60 → par estável e promissor
 *      - Volume crescente → whale flow aumentando
 *      - Fragmentação mantida → edge sustentável
 *   4. Sinais negativos:
 *      - Score caindo → competição apareceu OU par perdendo edge
 *      - Volume caindo → token morrendo
 *      - Fragmentação encolhendo → arb sendo capturado por outros
 *
 * Output: report textual + recomendação ("MANTER" / "MONITORAR" / "DESPROMOTER")
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { ScraperReport, RankedCandidate } from '../output/types';

export interface BacktestEntry {
  pairId: string;
  chainName: string;
  /** Quantos reports históricos foram encontrados pra esse par. */
  observations: number;
  /** Score médio histórico. */
  avgScore: number;
  /** Desvio padrão do score (estabilidade). */
  scoreStdDev: number;
  /** Tendência do score: positivo = subindo, negativo = caindo. */
  scoreTrend: number;
  avgVolume24h: number;
  avgFragmentation: number;
  /** Primeiro report onde par apareceu. */
  firstSeenAt: string;
  /** Último report onde par apareceu. */
  lastSeenAt: string;
  /** Recomendação automática baseada nos sinais. */
  recommendation: 'KEEP' | 'WATCH' | 'DEMOTE';
  /** Razão textual. */
  reason: string;
}

export interface BacktestReport {
  generatedAt: string;
  reportsAnalyzed: number;
  entries: BacktestEntry[];
}

interface PairHistoryPoint {
  generatedAt: string;
  chainName: string;
  score: number;
  volume24h: number;
  fragmentation: number;
}

/**
 * Coleta histórico de cada par a partir de todos os reports/<ISO>.json.
 */
function collectPairHistory(reportsDir: string): Map<string, PairHistoryPoint[]> {
  const history = new Map<string, PairHistoryPoint[]>();
  if (!existsSync(reportsDir)) return history;

  const files = readdirSync(reportsDir).filter((f) => f.endsWith('.json') && f !== 'latest.json');
  for (const file of files) {
    try {
      const path = resolve(reportsDir, file);
      const raw = readFileSync(path, 'utf-8');
      const report = JSON.parse(raw) as ScraperReport;
      for (const result of report.results) {
        for (const c of result.topCandidates) {
          const key = `${result.chainName}:${c.pairId}`;
          if (!history.has(key)) history.set(key, []);
          history.get(key)!.push({
            generatedAt: report.generatedAt,
            chainName: result.chainName,
            score: c.score,
            volume24h: c.totalVolumeUsd24h,
            fragmentation: c.breakdown.fragmentationRatio,
          });
        }
      }
    } catch {
      // Skip arquivos corrompidos
    }
  }

  // Ordena por timestamp asc dentro de cada par
  for (const points of history.values()) {
    points.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  }

  return history;
}

/**
 * Calcula stats descritivos + recomendação pra um par.
 */
function analyzePair(key: string, points: PairHistoryPoint[]): BacktestEntry {
  const [chainName, pairId] = key.split(':');
  const observations = points.length;

  if (observations < 2) {
    return {
      pairId: pairId ?? key,
      chainName: chainName ?? 'unknown',
      observations,
      avgScore: points[0]?.score ?? 0,
      scoreStdDev: 0,
      scoreTrend: 0,
      avgVolume24h: points[0]?.volume24h ?? 0,
      avgFragmentation: points[0]?.fragmentation ?? 0,
      firstSeenAt: points[0]?.generatedAt ?? '',
      lastSeenAt: points[0]?.generatedAt ?? '',
      recommendation: 'WATCH',
      reason: 'observações insuficientes — precisa mais cycles',
    };
  }

  const scores = points.map((p) => p.score);
  const avgScore = scores.reduce((s, v) => s + v, 0) / observations;
  const variance = scores.reduce((s, v) => s + Math.pow(v - avgScore, 2), 0) / observations;
  const scoreStdDev = Math.sqrt(variance);

  // Tendência: regressão linear simples (slope)
  const n = observations;
  const sumX = n * (n - 1) / 2; // 0+1+2+...+(n-1)
  const sumX2 = (n - 1) * n * (2 * n - 1) / 6;
  const sumY = scores.reduce((s, v) => s + v, 0);
  const sumXY = scores.reduce((s, v, i) => s + i * v, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const scoreTrend = slope;

  const avgVolume = points.reduce((s, p) => s + p.volume24h, 0) / observations;
  const avgFrag = points.reduce((s, p) => s + p.fragmentation, 0) / observations;

  // Recomendação heurística
  let recommendation: BacktestEntry['recommendation'] = 'WATCH';
  let reason = '';

  if (avgScore >= 60 && scoreStdDev <= 10 && slope >= -1) {
    recommendation = 'KEEP';
    reason = `score médio ${avgScore.toFixed(1)} estável (DP ${scoreStdDev.toFixed(1)}, trend ${slope.toFixed(2)}) — par sólido`;
  } else if (avgScore < 45 || slope < -3) {
    recommendation = 'DEMOTE';
    reason =
      avgScore < 45
        ? `score médio ${avgScore.toFixed(1)} baixo (< 45)`
        : `score caindo rápido (trend ${slope.toFixed(2)} por cycle) — edge sumindo`;
  } else {
    recommendation = 'WATCH';
    reason = `score médio ${avgScore.toFixed(1)}, trend ${slope.toFixed(2)} — sinal ainda inconclusivo`;
  }

  return {
    pairId: pairId ?? key,
    chainName: chainName ?? 'unknown',
    observations,
    avgScore: Math.round(avgScore * 10) / 10,
    scoreStdDev: Math.round(scoreStdDev * 10) / 10,
    scoreTrend: Math.round(slope * 100) / 100,
    avgVolume24h: avgVolume,
    avgFragmentation: avgFrag,
    firstSeenAt: points[0]?.generatedAt ?? '',
    lastSeenAt: points[observations - 1]?.generatedAt ?? '',
    recommendation,
    reason,
  };
}

export function runBacktest(reportsDir: string, logger?: LoggerLike): BacktestReport {
  logger?.info({ reportsDir }, '📊 Iniciando backtest histórico');

  const history = collectPairHistory(reportsDir);
  const entries: BacktestEntry[] = [];

  for (const [key, points] of history.entries()) {
    entries.push(analyzePair(key, points));
  }

  // Ordena por avgScore desc
  entries.sort((a, b) => b.avgScore - a.avgScore);

  const report: BacktestReport = {
    generatedAt: new Date().toISOString(),
    reportsAnalyzed: existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((f) => f.endsWith('.json') && f !== 'latest.json').length
      : 0,
    entries,
  };

  // Console summary
  console.log(`\n📊 Backtest histórico — ${report.reportsAnalyzed} reports analisados, ${entries.length} pares únicos`);
  console.log('─'.repeat(80));

  const byChain = new Map<string, BacktestEntry[]>();
  for (const e of entries) {
    if (!byChain.has(e.chainName)) byChain.set(e.chainName, []);
    byChain.get(e.chainName)!.push(e);
  }

  for (const [chain, chainEntries] of byChain) {
    console.log(`\n=== ${chain} ===`);
    for (const e of chainEntries.slice(0, 10)) {
      const emoji = e.recommendation === 'KEEP' ? '✅' : e.recommendation === 'WATCH' ? '⚠️ ' : '🛑';
      console.log(
        `${emoji} ${e.pairId.padEnd(22)} obs=${e.observations}  avg=${e.avgScore.toFixed(1)}  ` +
          `DP=${e.scoreStdDev.toFixed(1)}  trend=${e.scoreTrend.toFixed(2)}  →  ${e.recommendation}`,
      );
      console.log(`    ${e.reason}`);
    }
  }

  return report;
}
