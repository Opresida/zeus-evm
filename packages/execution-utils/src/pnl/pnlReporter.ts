/**
 * PnlReporter — Item 10 P7 do checklist.
 *
 * Gera relatórios humanos consumindo `PnlReconciler.stats()`:
 *  - Daily digest Markdown (pra Discord webhook)
 *  - Weekly deep dive Markdown (pra docs ou Discord embed grande)
 *
 * Filosofia: usa dados que JÁ EXISTEM no reconciler — não duplica state.
 * Reporter é stateless.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { PnlReconciler } from './pnlReconciler';
import type { PnlAggregator, AggregationResult } from './pnlAggregator';
import type { AttributionCause, PnlReconciliation } from './pnlSchema';

export interface DigestOptions {
  /** Período do digest (default 'daily'). Afeta título + window. */
  period?: 'daily' | 'weekly';
  /** Inclui suggestions automatizáveis no fim. Default true. */
  includeSuggestions?: boolean;
  /** Max sugestões no relatório. Default 5. */
  maxSuggestions?: number;
}

interface DigestData {
  title: string;
  total_recons: number;
  expected_total_usd: number;
  realized_total_usd: number;
  net_delta_usd: number;
  net_delta_pct: number;
  avg_drift_bps: number;
  attribution_breakdown: Array<{ cause: AttributionCause; count: number; lost_usd: number }>;
  best_protocol?: { protocol: string; wins: number; total: number; drift_bps: number };
  worst_protocol?: { protocol: string; wins: number; total: number; drift_bps: number };
  suggestions: string[];
}

/**
 * Constrói payload do digest a partir do reconciler.
 * Não envia — só monta. Caller decide pra onde mandar.
 */
export function buildDigest(reconciler: PnlReconciler, opts: DigestOptions = {}): DigestData {
  const stats = reconciler.stats();
  const recent = reconciler.recent(500); // analisa até 500 recents

  const period = opts.period ?? 'daily';
  const now = new Date();
  const title = `ZEUS ${period === 'weekly' ? 'Weekly' : 'Daily'} Reconciliation — ${now.toISOString().slice(0, 10)}`;

  const net_delta_pct = stats.expectedTotalUsd > 0
    ? (stats.netDeltaUsd / stats.expectedTotalUsd) * 100
    : 0;

  // ─── Attribution breakdown ───
  const lostByCause: Record<string, number> = {};
  for (const r of recent) {
    if (r.deltas.net_delta_usd < 0) {
      const cause = r.attribution.primary_cause;
      lostByCause[cause] = (lostByCause[cause] ?? 0) + Math.abs(r.deltas.net_delta_usd);
    }
  }

  const attribution_breakdown = (Object.entries(stats.attributionDistribution) as Array<[AttributionCause, number]>)
    .filter(([, count]) => count > 0)
    .map(([cause, count]) => ({
      cause,
      count,
      lost_usd: lostByCause[cause] ?? 0,
    }))
    .sort((a, b) => b.count - a.count);

  // ─── Best/Worst protocol ───
  const byProtocol = new Map<string, { wins: number; total: number; drift_sum: number }>();
  for (const r of recent) {
    const key = r.protocol;
    const entry = byProtocol.get(key) ?? { wins: 0, total: 0, drift_sum: 0 };
    entry.total++;
    if (r.realized.net_profit_usd > 0) entry.wins++;
    entry.drift_sum += r.deltas.profit_delta_bps;
    byProtocol.set(key, entry);
  }
  const protocolStats = [...byProtocol.entries()]
    .filter(([, e]) => e.total >= 3) // pelo menos 3 ops pra significância
    .map(([protocol, e]) => ({
      protocol,
      wins: e.wins,
      total: e.total,
      drift_bps: Math.round(e.drift_sum / e.total),
    }));

  protocolStats.sort((a, b) => b.drift_bps - a.drift_bps);
  const best_protocol = protocolStats[0];
  const worst_protocol = protocolStats.length > 1 ? protocolStats[protocolStats.length - 1] : undefined;

  // ─── Suggestions ───
  const suggestions = opts.includeSuggestions !== false ? buildSuggestions(recent, opts.maxSuggestions ?? 5) : [];

  return {
    title,
    total_recons: stats.totalReconciliations,
    expected_total_usd: stats.expectedTotalUsd,
    realized_total_usd: stats.realizedTotalUsd,
    net_delta_usd: stats.netDeltaUsd,
    net_delta_pct,
    avg_drift_bps: stats.avgDriftBps,
    attribution_breakdown,
    best_protocol,
    worst_protocol,
    suggestions,
  };
}

/**
 * Formata DigestData como Markdown (pra Discord webhook ou .md file).
 */
export function formatMarkdown(data: DigestData): string {
  const lines: string[] = [];

  lines.push(`## 📊 ${data.title}`);
  lines.push('');
  lines.push(`**Total Txs Confirmed:** ${data.total_recons}`);
  if (data.total_recons === 0) {
    lines.push('');
    lines.push('_No reconciliations in window — sem operações confirmadas ainda._');
    return lines.join('\n');
  }

  lines.push(
    `**Net P&L Realized:** $${data.realized_total_usd.toFixed(2)}` +
    ` (Expected: $${data.expected_total_usd.toFixed(2)}` +
    `, Drift: ${data.net_delta_pct >= 0 ? '+' : ''}${data.net_delta_pct.toFixed(1)}%)`,
  );
  lines.push(`**Avg Drift (bps weighted):** ${data.avg_drift_bps > 0 ? '+' : ''}${data.avg_drift_bps}`);
  lines.push('');

  // ─── Attribution ───
  lines.push('### 🎯 Top Attribution Causes');
  for (const item of data.attribution_breakdown.slice(0, 6)) {
    const emoji = item.cause === 'within_normal_band' ? '✅' : '🔻';
    const lossPart = item.lost_usd > 0 ? ` ($${item.lost_usd.toFixed(2)} loss)` : '';
    lines.push(`- ${emoji} **${item.cause}** — ${item.count} txs${lossPart}`);
  }
  lines.push('');

  // ─── Best/Worst protocol ───
  if (data.best_protocol) {
    lines.push('### 🏆 Best Performing');
    const b = data.best_protocol;
    lines.push(`- **${b.protocol}**: ${b.wins}/${b.total} wins, drift ${b.drift_bps > 0 ? '+' : ''}${b.drift_bps}bps`);
    lines.push('');
  }
  if (data.worst_protocol && data.worst_protocol.protocol !== data.best_protocol?.protocol) {
    lines.push('### ⚠️ Worst Performing');
    const w = data.worst_protocol;
    lines.push(`- **${w.protocol}**: ${w.wins}/${w.total} wins, drift ${w.drift_bps > 0 ? '+' : ''}${w.drift_bps}bps`);
    lines.push('');
  }

  // ─── Suggestions ───
  if (data.suggestions.length > 0) {
    lines.push('### 💡 Automated Suggestions');
    for (const s of data.suggestions) {
      lines.push(`- ${s}`);
    }
  }

  return lines.join('\n');
}

/**
 * Envia digest pra Discord webhook (text/markdown content, não embed).
 * Discord aceita Markdown nativamente em messages.
 */
export async function sendToDiscord(
  webhookUrl: string,
  markdown: string,
  logger?: LoggerLike,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    // Discord limita content em 2000 chars — truncar se necessário
    const content = markdown.length > 1900
      ? markdown.slice(0, 1900) + '\n\n_(truncado pra Discord 2000-char limit)_'
      : markdown;

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ZEUS PnL Reporter',
        content,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger?.warn(
        { status: res.status, body: text.slice(0, 200) },
        'PnlReporter Discord webhook falhou',
      );
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    logger?.info({ status: res.status }, '📤 PnlReporter digest enviado pro Discord');
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn({ err: msg }, 'PnlReporter: erro enviando pra Discord');
    return { ok: false, status: 0, error: msg };
  }
}

// ─── Weekly Deep Dive (Item 10 P8) ───

export interface WeeklyDigestData {
  title: string;
  generated_at: string;
  total_samples_7d: number;
  by_protocol: AggregationResult[];
  by_venue: AggregationResult[];
  by_pair: AggregationResult[];
  by_hour_utc: AggregationResult[];
  worst_overall: AggregationResult[];
  top_performers: AggregationResult[];
}

/**
 * Constrói weekly deep-dive a partir do PnlAggregator (rolling 7d).
 * Item 10 P8 do checklist.
 *
 * Stateless. Consome só `aggregator.weeklySummary()` + `topPerformers()`.
 */
export function buildWeeklyDigest(aggregator: PnlAggregator): WeeklyDigestData {
  const summary = aggregator.weeklySummary();
  const stats = aggregator.stats();
  const top_performers = aggregator.topPerformers('protocol', '7d', 5);

  return {
    title: `ZEUS Weekly PnL Deep Dive — ${new Date().toISOString().slice(0, 10)}`,
    generated_at: new Date().toISOString(),
    total_samples_7d: stats.total_samples,
    by_protocol: summary.by_protocol,
    by_venue: summary.by_venue,
    by_pair: summary.by_pair,
    by_hour_utc: summary.by_hour_utc,
    worst_overall: summary.worst_overall,
    top_performers,
  };
}

/**
 * Formata weekly digest como Markdown (deep dive — pode passar de 2k chars).
 * Item 10 P8 do checklist.
 *
 * Discord webhook trunca em 1900, então pra weekly deep dive grande, salvar como
 * .md file também (caller pode chamar fs.writeFileSync com este return).
 */
export function formatWeeklyMarkdown(data: WeeklyDigestData): string {
  const lines: string[] = [];
  lines.push(`# 📈 ${data.title}`);
  lines.push('');
  lines.push(`_Generated at ${data.generated_at}_`);
  lines.push('');
  lines.push(`**Total reconciliations (7d):** ${data.total_samples_7d}`);
  if (data.total_samples_7d === 0) {
    lines.push('');
    lines.push('_Sem operações nos últimos 7 dias._');
    return lines.join('\n');
  }
  lines.push('');

  if (data.by_protocol.length > 0) {
    lines.push('## 📂 Por Protocolo');
    for (const r of data.by_protocol) {
      lines.push(formatAggregationLine(r));
    }
    lines.push('');
  }

  if (data.by_venue.length > 0) {
    lines.push('## 🏪 Por Venue');
    for (const r of data.by_venue) {
      lines.push(formatAggregationLine(r));
    }
    lines.push('');
  }

  if (data.by_pair.length > 0) {
    lines.push('## 💱 Por Par/Oportunidade');
    for (const r of data.by_pair) {
      lines.push(formatAggregationLine(r));
    }
    lines.push('');
  }

  if (data.by_hour_utc.length > 0) {
    lines.push('## ⏰ Por Hora UTC');
    for (const r of data.by_hour_utc) {
      lines.push(formatAggregationLine(r));
    }
    lines.push('');
  }

  if (data.top_performers.length > 0) {
    lines.push('## 🏆 Top Performers (win_rate × samples)');
    for (const r of data.top_performers) {
      lines.push(formatAggregationLine(r));
    }
    lines.push('');
  }

  if (data.worst_overall.length > 0) {
    lines.push('## ⚠️ Worst (Net Delta Negativo)');
    for (const r of data.worst_overall) {
      lines.push(formatAggregationLine(r));
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Envia weekly markdown como Discord webhook (auto-trunca em 1900 chars).
 * Pra deep dive completo, salvar separado em .md.
 */
export async function sendWeeklyDigestToDiscord(
  webhookUrl: string,
  markdown: string,
  logger?: LoggerLike,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const content = markdown.length > 1900
      ? markdown.slice(0, 1900) + '\n\n_(truncado — ver .md completo)_'
      : markdown;
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ZEUS PnL Weekly', content }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger?.warn({ status: res.status, body: text.slice(0, 200) }, 'PnL weekly Discord falhou');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    logger?.info({ status: res.status }, '📤 PnL weekly digest enviado pro Discord');
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn({ err: msg }, 'PnL weekly: erro enviando');
    return { ok: false, status: 0, error: msg };
  }
}

function formatAggregationLine(r: AggregationResult): string {
  const winPct = (r.win_rate * 100).toFixed(0);
  const driftSign = r.avg_drift_bps > 0 ? '+' : '';
  const deltaSign = r.net_delta_usd >= 0 ? '+' : '';
  const slipPart = r.avg_slippage_real_bps !== undefined
    ? ` slip=${r.avg_slippage_real_bps}bps`
    : '';
  return (
    `- **${r.key}**: ${r.samples} ops, ` +
    `${winPct}% win, ` +
    `drift ${driftSign}${r.avg_drift_bps}bps, ` +
    `Δ ${deltaSign}$${r.net_delta_usd.toFixed(2)}${slipPart}`
  );
}

// ─── Helpers internos ───

function buildSuggestions(recent: PnlReconciliation[], maxCount: number): string[] {
  const suggestions = new Map<string, { count: number; total_loss: number }>();

  for (const r of recent) {
    if (!r.attribution.automatable) continue;
    if (r.deltas.net_delta_usd >= 0) continue;

    let key: string;
    switch (r.attribution.primary_cause) {
      case 'pool_slippage':
        key = `pool_slippage:${r.context.venue ?? 'unknown'}`;
        break;
      case 'gas_spike':
        key = 'gas_spike';
        break;
      case 'bribe_overshoot':
        key = 'bribe_overshoot';
        break;
      case 'frontrun_loss':
        key = `frontrun:${r.context.competitor_winner_sender?.slice(0, 10) ?? 'unknown'}`;
        break;
      case 'reorg_recovery_cost':
        key = 'reorg_recovery';
        break;
      default:
        continue;
    }

    const existing = suggestions.get(key) ?? { count: 0, total_loss: 0 };
    existing.count++;
    existing.total_loss += Math.abs(r.deltas.net_delta_usd);
    suggestions.set(key, existing);
  }

  return [...suggestions.entries()]
    .sort((a, b) => b[1].total_loss - a[1].total_loss)
    .slice(0, maxCount)
    .map(([key, data]) => {
      const [cause, ctx] = key.split(':');
      switch (cause) {
        case 'pool_slippage':
          return `**${data.count}x pool_slippage no ${ctx ?? 'venue'}** ($${data.total_loss.toFixed(2)} loss) — considerar mudar fee tier`;
        case 'gas_spike':
          return `**${data.count}x gas_spike** ($${data.total_loss.toFixed(2)} loss) — calibrar GAS_MAX_FEE_MULTIPLIER ou pausar em horários de spike`;
        case 'bribe_overshoot':
          return `**${data.count}x bribe_overshoot** ($${data.total_loss.toFixed(2)} loss) — reduzir BRIBE_DEFAULT_BPS`;
        case 'frontrun':
          return `**${data.count}x frontrun por ${ctx}** ($${data.total_loss.toFixed(2)} loss) — competitor agressivo, calibrar bribe higher`;
        case 'reorg_recovery':
          return `**${data.count}x reorg recovery** ($${data.total_loss.toFixed(2)} loss) — subir confirmations required`;
        default:
          return `${key}: ${data.count} occurrences ($${data.total_loss.toFixed(2)})`;
      }
    });
}
