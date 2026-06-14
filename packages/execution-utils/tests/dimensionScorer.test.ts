/**
 * Testes do DimensionScorer (OIE Fases 2-3 — Protocol / Pool / Token Score).
 */

import { describe, expect, it } from 'vitest';

import {
  scoreDimension,
  rankDimension,
  formatDimensionRankingMarkdown,
  DIMENSION_WEIGHTS,
  type DimensionStats,
} from '../src/scoring';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function mkStats(over: Partial<DimensionStats> = {}): DimensionStats {
  return {
    key: 'aave-v3',
    total_ops: 100,
    successful_ops: 80,
    failed_ops: 20,
    net_profit_usd: 80 * 50, // $50/op confirmado
    unique_competitors: 5,
    avg_amount_usd: 50_000,
    active_hours: 24,
    ...over,
  };
}

describe('DimensionScorer — OIE Fases 2-3', () => {
  it('pesos positivos somam ~1 em cada dimensão', () => {
    for (const dim of ['protocol', 'pool', 'token'] as const) {
      const w = DIMENSION_WEIGHTS[dim];
      const positives = w.profitability + w.density + w.win_rate + w.persistence + w.liquidity;
      expect(positives).toBeCloseTo(1.0, 5);
    }
  });

  it('retorna null abaixo do minOps', () => {
    const s = scoreDimension('protocol', mkStats({ total_ops: 3 }), { windowMs: WEEK_MS });
    expect(s).toBeNull();
  });

  it('protocol: win_rate = successful / (successful + failed)', () => {
    const s = scoreDimension('protocol', mkStats(), { windowMs: WEEK_MS })!;
    expect(s.components.win_rate).toBeCloseTo(0.8, 3); // 80/100
    expect(s.raw.avg_net_usd).toBe(50);
    expect(s.components.profitability).toBe(1.0); // $50 = saturação
  });

  it('protocol bom pontua mais que protocol ruim', () => {
    const bom = scoreDimension('protocol', mkStats({
      key: 'morpho-blue',
      successful_ops: 90,
      failed_ops: 10,
      net_profit_usd: 90 * 45,
      unique_competitors: 4,
    }), { windowMs: WEEK_MS })!;
    const ruim = scoreDimension('protocol', mkStats({
      key: 'aave-v3-mainstream',
      successful_ops: 20,
      failed_ops: 80,
      net_profit_usd: 20 * 4,
      unique_competitors: 60,
    }), { windowMs: WEEK_MS })!;
    expect(bom.score).toBeGreaterThan(ruim.score);
    expect(ruim.components.competition).toBe(1.0); // 60 > 50 → cap
  });

  it('pool usa persistência + liquidez (não usa win_rate no peso)', () => {
    expect(DIMENSION_WEIGHTS.pool.win_rate).toBe(0);
    const fundo = scoreDimension('pool', mkStats({
      key: 'USDC/WETH',
      avg_amount_usd: 100_000,
      active_hours: 168, // janela inteira (7d × 24h)
    }), { windowMs: WEEK_MS })!;
    const raso = scoreDimension('pool', mkStats({
      key: 'SHIB/WETH',
      avg_amount_usd: 1_000,
      active_hours: 2,
    }), { windowMs: WEEK_MS })!;
    expect(fundo.components.liquidity).toBe(1.0); // $100k saturação
    expect(fundo.components.persistence).toBe(1.0); // 168/168h
    expect(fundo.score).toBeGreaterThan(raso.score);
  });

  it('token usa persistência + frequência', () => {
    expect(DIMENSION_WEIGHTS.token.persistence).toBeGreaterThan(0);
    expect(DIMENSION_WEIGHTS.token.density).toBeGreaterThan(0);
    const s = scoreDimension('token', mkStats({ key: 'WETH' }), { windowMs: WEEK_MS })!;
    expect(s.dimension).toBe('token');
    expect(s.key).toBe('WETH');
  });

  it('rankDimension ordena por score desc e descarta minOps', () => {
    const list: DimensionStats[] = [
      mkStats({ key: 'morpho-blue', successful_ops: 95, failed_ops: 5, net_profit_usd: 95 * 50, unique_competitors: 3 }),
      mkStats({ key: 'compound-v3', successful_ops: 50, failed_ops: 50, net_profit_usd: 50 * 20, unique_competitors: 30 }),
      mkStats({ key: 'tiny', total_ops: 2 }), // abaixo do minOps → descartado
    ];
    const ranking = rankDimension('protocol', list, { windowMs: WEEK_MS });
    expect(ranking.length).toBe(2);
    expect(ranking[0]!.key).toBe('morpho-blue');
    expect(ranking[0]!.score).toBeGreaterThanOrEqual(ranking[1]!.score);
  });

  it('formatter inclui medalhas e título da dimensão', () => {
    const ranking = rankDimension('protocol', [
      mkStats({ key: 'morpho-blue' }),
    ], { windowMs: WEEK_MS });
    const md = formatDimensionRankingMarkdown('protocol', ranking);
    expect(md).toContain('🥇');
    expect(md).toContain('Protocol Ranking');
    expect(md).toContain('morpho-blue');
  });

  it('formatter vazio quando sem dados', () => {
    const md = formatDimensionRankingMarkdown('token', []);
    expect(md).toContain('sem dados suficientes');
  });

  it('avg_amount_usd ausente não quebra (liquidity = 0)', () => {
    const s = scoreDimension('pool', mkStats({ avg_amount_usd: undefined }), { windowMs: WEEK_MS })!;
    expect(s.components.liquidity).toBe(0);
  });
});
