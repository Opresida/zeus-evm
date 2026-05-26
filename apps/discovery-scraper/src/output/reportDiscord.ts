/**
 * Discord webhook report — formato consolidado pra o Humberto receber 1x/dia.
 *
 * Layout:
 *   - 1 embed por chain
 *   - Top N candidates listados com score + breakdown principal
 *   - Marca [NOVO ⭐] em quem ainda não está em target-pairs
 *   - Footer com elapsed + total considered
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { ScraperReport, RankedCandidate } from './types';

const COLOR_CHAIN_BASE = 0x0052ff; // Coinbase blue
const COLOR_CHAIN_OP = 0xfd0420; // OP red
const COLOR_DEFAULT = 0x3498db;

const TROPHIES = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  timestamp: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}

interface DiscordPayload {
  username?: string;
  embeds: DiscordEmbed[];
}

function colorForChain(chainId: number): number {
  if (chainId === 8453) return COLOR_CHAIN_BASE;
  if (chainId === 10) return COLOR_CHAIN_OP;
  return COLOR_DEFAULT;
}

function formatCandidate(rank: number, c: RankedCandidate): string {
  const trophy = TROPHIES[rank] ?? `${rank + 1}.`;
  const newTag = c.isNew ? ' **⭐ NOVO**' : '';
  const ratio = c.breakdown.fragmentationRatio.toFixed(1);
  const volPct = c.breakdown.volumePctOfTvl.toFixed(1);
  const tvl = formatUsd(c.totalTvlUsd);
  const vol24h = formatUsd(c.totalVolumeUsd24h);

  return [
    `${trophy} **${c.pairId}** — score ${c.score.toFixed(1)}${newTag}`,
    `   frag=${ratio}x · TVL=${tvl} · vol/d=${vol24h} (${volPct}% giro)`,
    `   frag:${c.breakdown.fragmentation} · vol:${c.breakdown.volumeEfficiency} · ` +
      `tvl:${c.breakdown.tvlSweetZone} · vlt:${c.breakdown.volatility} · ` +
      `age:${c.breakdown.poolAge} · cmp:${c.breakdown.competition}`,
  ].join('\n');
}

function formatUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  return `$${usd.toFixed(0)}`;
}

export interface DiscordReportOpts {
  webhookUrl: string;
  timeoutMs?: number;
  logger?: LoggerLike;
}

export async function sendDiscordReport(
  report: ScraperReport,
  opts: DiscordReportOpts,
): Promise<void> {
  const { webhookUrl, timeoutMs = 8_000, logger } = opts;

  const embeds: DiscordEmbed[] = report.results.map((chain) => {
    const newCount = chain.topCandidates.filter((c) => c.isNew).length;
    const description = chain.topCandidates.length === 0
      ? '_Nenhum candidato passou pelos hard filters._'
      : chain.topCandidates.map((c, i) => formatCandidate(i, c)).join('\n\n');

    return {
      title: `📊 ${chain.chainName} — Top ${chain.topCandidates.length}`,
      description,
      color: colorForChain(chain.chainId),
      timestamp: report.generatedAt,
      fields: [
        {
          name: 'Pools coletados',
          value: String(chain.poolsCollected),
          inline: true,
        },
        {
          name: 'Pares considerados',
          value: String(chain.pairsConsidered),
          inline: true,
        },
        {
          name: 'Passaram filtros',
          value: String(chain.pairsPassedFilters),
          inline: true,
        },
      ],
      footer: { text: `Novos descobertos: ${newCount} · ${chain.chainName}` },
    };
  });

  const payload: DiscordPayload = {
    username: 'ZEUS Discovery Scraper',
    embeds,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => '');
      logger?.warn(
        { status: res.status, body: text.slice(0, 200) },
        `Discord webhook retornou ${res.status}`,
      );
    } else {
      logger?.info({ chains: report.results.length }, '📤 Relatório enviado pro Discord');
    }
  } catch (err) {
    logger?.warn(
      { err: err instanceof Error ? err.message : err },
      'Falha ao enviar Discord webhook',
    );
  }
}
