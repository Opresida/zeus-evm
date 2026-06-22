/**
 * FailureReporter — Item 4 A8 do checklist.
 *
 * Weekly digest com decomposição de TODAS failures rolling 7d:
 *  - Total + USD lost agregado
 *  - Top causas (reverted_on_chain, lost_race, gas_outbid, etc)
 *  - Top oportunidades perdidas (por opportunity_id)
 *  - Top competidores que ganharam (se competitor data preenchido)
 *  - Padrões temporais (hora UTC com mais failures)
 *
 * Filosofia: stateless. Consulta FailureCollector.recent() + agrega.
 * Pode ser usado standalone OU via scheduler 7d no liquidator boot.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { FailureCollector } from './failureCollector';
import type { FailureEvent, FailureCategory } from './failureSchema';

export interface FailureDigestOptions {
  /** Limit max failures pra analisar. Default 1000. */
  maxFailures?: number;
  /** Top N por causa pra mostrar. Default 6. */
  topCausesLimit?: number;
  /** Top N competidores pra mostrar. Default 5. */
  topCompetitorsLimit?: number;
}

interface FailureDigestData {
  title: string;
  total_failures: number;
  total_gas_usd_lost: number;
  total_expected_profit_lost_usd: number;  // soma de expected_profit_usd dos failures
  by_category: Array<{ category: FailureCategory; count: number; usd_lost: number }>;
  by_protocol: Array<{ protocol: string; count: number; usd_lost: number }>;
  top_competitors: Array<{ sender: string; alias?: string; wins: number; total_taken_usd: number }>;
  top_lost_opportunities: Array<{ opportunity_id: string; failures: number; total_expected_usd: number }>;
  failures_by_hour_utc: Array<{ hour: number; count: number }>;
}

/**
 * Constrói digest a partir do FailureCollector.recent().
 */
export function buildFailureDigest(
  collector: FailureCollector,
  opts: FailureDigestOptions = {},
): FailureDigestData {
  const maxFailures = opts.maxFailures ?? 1000;
  const topCausesLimit = opts.topCausesLimit ?? 6;
  const topCompetitorsLimit = opts.topCompetitorsLimit ?? 5;

  const failures = collector.recent(maxFailures);
  const now = new Date();
  const weekNum = weekOfYear(now);
  const title = `ZEUS Weekly Failure Digest — Semana ${weekNum} de ${now.getUTCFullYear()}`;

  const total_gas_usd_lost = failures.reduce((acc, f) => acc + (f.our_gas_usd_lost ?? 0), 0);
  const total_expected_profit_lost = failures.reduce((acc, f) => acc + (f.expected_profit_usd ?? 0), 0);

  // ─── By category ───
  const byCategoryMap = new Map<FailureCategory, { count: number; usd_lost: number }>();
  for (const f of failures) {
    const cur = byCategoryMap.get(f.category) ?? { count: 0, usd_lost: 0 };
    cur.count++;
    cur.usd_lost += f.our_gas_usd_lost ?? 0;
    byCategoryMap.set(f.category, cur);
  }
  const by_category = [...byCategoryMap.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topCausesLimit);

  // ─── By protocol ───
  const byProtoMap = new Map<string, { count: number; usd_lost: number }>();
  for (const f of failures) {
    if (!f.protocol) continue;
    const cur = byProtoMap.get(f.protocol) ?? { count: 0, usd_lost: 0 };
    cur.count++;
    cur.usd_lost += f.our_gas_usd_lost ?? 0;
    byProtoMap.set(f.protocol, cur);
  }
  const by_protocol = [...byProtoMap.entries()]
    .map(([protocol, v]) => ({ protocol, ...v }))
    .sort((a, b) => b.count - a.count);

  // ─── Top competitors (depende competitor_resolver ter preenchido) ───
  const competitorMap = new Map<string, { alias?: string; wins: number; total_taken_usd: number }>();
  for (const f of failures) {
    if (!f.competitor_winner_sender) continue;
    const key = f.competitor_winner_sender.toLowerCase();
    const cur = competitorMap.get(key) ?? {
      alias: f.competitor_winner_alias,
      wins: 0,
      total_taken_usd: 0,
    };
    cur.wins++;
    cur.total_taken_usd += f.expected_profit_usd ?? 0;
    if (f.competitor_winner_alias) cur.alias = f.competitor_winner_alias;
    competitorMap.set(key, cur);
  }
  const top_competitors = [...competitorMap.entries()]
    .map(([sender, v]) => ({ sender, ...v }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, topCompetitorsLimit);

  // ─── Top lost opportunities ───
  const oppMap = new Map<string, { failures: number; total_expected_usd: number }>();
  for (const f of failures) {
    if (!f.opportunity_id) continue;
    const cur = oppMap.get(f.opportunity_id) ?? { failures: 0, total_expected_usd: 0 };
    cur.failures++;
    cur.total_expected_usd += f.expected_profit_usd ?? 0;
    oppMap.set(f.opportunity_id, cur);
  }
  const top_lost_opportunities = [...oppMap.entries()]
    .map(([opportunity_id, v]) => ({ opportunity_id, ...v }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 5);

  // ─── Failures por hora UTC ───
  const hourMap = new Map<number, number>();
  for (const f of failures) {
    const h = new Date(f.timestamp).getUTCHours();
    hourMap.set(h, (hourMap.get(h) ?? 0) + 1);
  }
  const failures_by_hour_utc = [...hourMap.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    title,
    total_failures: failures.length,
    total_gas_usd_lost,
    total_expected_profit_lost_usd: total_expected_profit_lost,
    by_category,
    by_protocol,
    top_competitors,
    top_lost_opportunities,
    failures_by_hour_utc,
  };
}

/**
 * Formata como Markdown pra Discord ou .md file.
 */
export function formatFailureMarkdown(data: FailureDigestData): string {
  const lines: string[] = [];
  lines.push(`## 💥 ${data.title}`);
  lines.push('');
  lines.push(`**Total failures:** ${data.total_failures}`);
  if (data.total_failures === 0) {
    lines.push('');
    lines.push('_Nenhuma failure rastreada — tudo verde esta semana 🎉_');
    return lines.join('\n');
  }
  lines.push(`**Gas USD perdido:** $${data.total_gas_usd_lost.toFixed(2)}`);
  lines.push(`**Profit USD esperado (não capturado):** $${data.total_expected_profit_lost_usd.toFixed(2)}`);
  lines.push('');

  // ─── Categories ───
  lines.push('### 🎯 Top Causas');
  for (const c of data.by_category) {
    lines.push(`- **${c.category}** — ${c.count} failures ($${c.usd_lost.toFixed(2)} gas perdido)`);
  }
  lines.push('');

  // ─── By protocol ───
  if (data.by_protocol.length > 0) {
    lines.push('### 📂 Por Protocolo');
    for (const p of data.by_protocol) {
      lines.push(`- **${p.protocol}**: ${p.count} failures ($${p.usd_lost.toFixed(2)})`);
    }
    lines.push('');
  }

  // ─── Top competitors ───
  if (data.top_competitors.length > 0) {
    lines.push('### 🏆 Top Competidores (quem nos venceu)');
    for (const c of data.top_competitors) {
      const aliasStr = c.alias ? ` (${c.alias})` : '';
      lines.push(
        `- **${c.sender.slice(0, 10)}...${c.sender.slice(-6)}**${aliasStr}` +
        ` — ${c.wins} wins, $${c.total_taken_usd.toFixed(2)} expected lost`,
      );
    }
    lines.push('');
    lines.push('_💡 Calibrar bribe higher contra esses adversários._');
    lines.push('');
  } else {
    lines.push('### 🏆 Competidores');
    lines.push('_Sem competidores identificados na janela (enriquecimento só roda com tx real on-chain)._');
    lines.push('');
  }

  // ─── Top lost opportunities ───
  if (data.top_lost_opportunities.length > 0) {
    lines.push('### 💸 Oportunidades Mais Perdidas');
    for (const o of data.top_lost_opportunities) {
      lines.push(
        `- ${o.opportunity_id.slice(0, 20)} — ${o.failures}× failed ($${o.total_expected_usd.toFixed(2)} expected)`,
      );
    }
    lines.push('');
  }

  // ─── Failures por hora ───
  if (data.failures_by_hour_utc.length > 0) {
    lines.push('### ⏰ Horas UTC com mais failures');
    const hoursStr = data.failures_by_hour_utc
      .map((h) => `${h.hour}h(${h.count})`)
      .join(', ');
    lines.push(hoursStr);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Envia digest pra Discord webhook.
 */
export async function sendFailureDigestToDiscord(
  webhookUrl: string,
  markdown: string,
  logger?: LoggerLike,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const content = markdown.length > 1900
      ? markdown.slice(0, 1900) + '\n\n_(truncado pra Discord 2000-char limit)_'
      : markdown;

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'ZEUS Failure Analyst',
        content,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger?.warn({ status: res.status, body: text.slice(0, 200) }, 'FailureReporter Discord falhou');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    logger?.info({ status: res.status }, '📤 Failure weekly digest enviado pro Discord');
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn({ err: msg }, 'FailureReporter: erro enviando');
    return { ok: false, status: 0, error: msg };
  }
}

function weekOfYear(d: Date): number {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThursdayDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNr + 3);
  return Math.ceil(((target.getTime() - firstThursday.getTime()) / 86400000 + 1) / 7);
}
