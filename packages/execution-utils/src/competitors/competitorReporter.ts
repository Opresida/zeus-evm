/**
 * CompetitorReporter — Item 5 F9 do checklist.
 *
 * Weekly Discord digest do competitive landscape:
 *  - Top 10 threats por overall_score
 *  - Stats agregados (total profiles, por categoria, gas highs/lows)
 *  - Bots conhecidos (com alias) destacados
 *  - Burst leaders + active hours overlap com nossas operações
 *
 * Filosofia: usa dados que JÁ EXISTEM no senderRegistry — stateless.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { SenderRegistry } from './senderRegistry';
import type { CompetitorProfile, CompetitorRegistryStats } from './senderSchema';

export interface CompetitorDigestOptions {
  topThreatsLimit?: number;
  /** Inclui apenas profiles com >N txs total (default 20). */
  minTxsForReport?: number;
}

interface CompetitorDigestData {
  title: string;
  total_profiles: number;
  by_category: CompetitorRegistryStats['by_category'];
  top_threats: Array<{
    sender: string;
    alias?: string;
    threat: number;
    category: string;
    total_txs: number;
    avg_gas_gwei: number;
    p95_gas_gwei: number;
  }>;
  notable_known_bots: Array<{ alias: string; sender: string; txs: number }>;
  most_active_hours_utc: number[];
}

const DEFAULT_TOP_LIMIT = 10;
const DEFAULT_MIN_TXS = 20;

/**
 * Constrói digest a partir do senderRegistry.
 */
export function buildCompetitorDigest(
  registry: SenderRegistry,
  opts: CompetitorDigestOptions = {},
): CompetitorDigestData {
  const topLimit = opts.topThreatsLimit ?? DEFAULT_TOP_LIMIT;
  const minTxs = opts.minTxsForReport ?? DEFAULT_MIN_TXS;

  const stats = registry.stats();
  const topThreats = registry.topThreats(topLimit * 3); // pega mais pra filtrar

  // Filtra por min txs + monta entries
  const top = topThreats
    .filter((p: CompetitorProfile) => p.total_txs >= minTxs)
    .slice(0, topLimit)
    .map((p: CompetitorProfile) => ({
      sender: p.sender,
      alias: p.known_alias,
      threat: p.threat.overall_score,
      category: p.category,
      total_txs: p.total_txs,
      avg_gas_gwei: p.gas.avg_priority_fee_gwei,
      p95_gas_gwei: p.gas.p95_priority_fee_gwei,
    }));

  // Bots conhecidos com alias (mesmo que não estejam no top threat)
  const notable: Array<{ alias: string; sender: string; txs: number }> = [];
  for (const t of topThreats) {
    if (t.known_alias && t.total_txs >= 5) {
      notable.push({
        alias: t.known_alias,
        sender: t.sender,
        txs: t.total_txs,
      });
    }
  }

  // Active hours globais — agrega hours UTC mais comuns nos top threats
  const hourCounts = new Array(24).fill(0);
  for (const t of topThreats.slice(0, 30)) {
    for (const h of t.activity.active_hours_utc) {
      hourCounts[h]++;
    }
  }
  const most_active_hours_utc = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((x) => x.hour);

  const now = new Date();
  return {
    title: `ZEUS Weekly Competitor Intelligence — Semana ${weekOfYear(now)} de ${now.getUTCFullYear()}`,
    total_profiles: stats.total_profiles,
    by_category: stats.by_category,
    top_threats: top,
    notable_known_bots: notable,
    most_active_hours_utc,
  };
}

/**
 * Formata digest como Markdown pra Discord.
 */
export function formatCompetitorMarkdown(data: CompetitorDigestData): string {
  const lines: string[] = [];
  lines.push(`## 🎯 ${data.title}`);
  lines.push('');
  lines.push(`**Total profiles tracked:** ${data.total_profiles}`);
  if (data.total_profiles === 0) {
    lines.push('');
    lines.push('_BlockHistoryScanner ainda não populou registry. Aguardar coleta._');
    return lines.join('\n');
  }
  lines.push('');

  // Categorias
  lines.push('### 📂 Por Categoria');
  for (const [cat, count] of Object.entries(data.by_category)) {
    if (count > 0) lines.push(`- **${cat}**: ${count}`);
  }
  lines.push('');

  // Top threats
  if (data.top_threats.length > 0) {
    lines.push(`### ⚠️ Top ${data.top_threats.length} Threats`);
    for (let i = 0; i < data.top_threats.length; i++) {
      const t = data.top_threats[i]!;
      const aliasStr = t.alias ? ` (${t.alias})` : '';
      lines.push(
        `${i + 1}. **${t.sender.slice(0, 10)}...${t.sender.slice(-6)}**${aliasStr}` +
        ` — ${t.category} | threat=${t.threat} | ${t.total_txs} txs | gas p95=${t.p95_gas_gwei.toFixed(2)}gwei`,
      );
    }
    lines.push('');
  }

  // Notable known bots
  if (data.notable_known_bots.length > 0) {
    lines.push('### 🏷️ Bots Conhecidos Identificados');
    for (const b of data.notable_known_bots) {
      lines.push(`- **${b.alias}**: ${b.txs} txs`);
    }
    lines.push('');
  }

  // Active hours
  if (data.most_active_hours_utc.length > 0) {
    const hoursStr = data.most_active_hours_utc.map((h) => `${h}h`).join(', ');
    lines.push(`### ⏰ Horas UTC mais ativas (entre top threats)`);
    lines.push(`${hoursStr}`);
    lines.push('');
    lines.push(`💡 _Calibrar bribe higher nessas janelas pra competir contra adversários ativos._`);
  }

  return lines.join('\n');
}

/**
 * Envia digest pro Discord webhook.
 */
export async function sendCompetitorDigestToDiscord(
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
        username: 'ZEUS Competitor Scout',
        content,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger?.warn({ status: res.status, body: text.slice(0, 200) }, 'CompetitorReporter Discord falhou');
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    logger?.info({ status: res.status }, '📤 Competitor digest enviado pro Discord');
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn({ err: msg }, 'CompetitorReporter: erro enviando');
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
