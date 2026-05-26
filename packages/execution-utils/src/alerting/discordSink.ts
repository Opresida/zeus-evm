/**
 * Discord webhook sink — formata eventos ZEUS pra embeds visuais do Discord.
 *
 * Cores por severidade (Discord embed):
 *   - info: cyan (0x3498db)
 *   - warn: amarelo (0xf1c40f)
 *   - critical: vermelho (0xe74c3c)
 *
 * Emojis por tipo de evento pra leitura rápida no celular.
 *
 * Setup Discord webhook:
 *   1. Crie um canal privado SEU (ex: #zeus-alerts) — NÃO compartilhar
 *   2. Server Settings > Integrations > Webhooks > New Webhook
 *   3. Cole o URL em DISCORD_WEBHOOK_URL do .env
 *
 * O URL contém token de autenticação — NUNCA commitar (já no .gitignore).
 */

import type { ZeusEvent, Severity } from '../events';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

const COLORS: Record<Severity, number> = {
  info: 0x3498db,
  warn: 0xf1c40f,
  critical: 0xe74c3c,
};

const EMOJIS: Record<ZeusEvent['type'], string> = {
  'liquidator.boot': '🚀',
  'liquidator.shutdown': '💤',
  'tx.confirmed': '💰',
  'tx.reverted_on_chain': '💥',
  'tx.reverted_pre_dispatch': '⏭️',
  'pnl.kill_switch_triggered': '🚨',
  'failure.cooldown_activated': '⏸️',
  'failure.cooldown_expired': '▶️',
  'gas.alert': '⛽',
  'gas.recovered': '✅',
  'discovery.tick_completed': '🔄',
  'whale.swap_detected': '🐋',
  'backrun.opportunity_found': '🎯',
  'backrun.dispatched': '⚡',
  'backrun.rejected': '🟡',
};

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
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

function buildEmbed(event: ZeusEvent): DiscordEmbed {
  const emoji = EMOJIS[event.type] ?? '📡';
  const color = COLORS[event.severity];
  const footer = { text: `${event.chain} · ${event.mode}` };

  // Switch por tipo pra montar embed específico
  switch (event.type) {
    case 'liquidator.boot':
      return {
        title: `${emoji} ZEUS Liquidator ONLINE`,
        description: `Bot iniciado em **${event.chain}** (mode: ${event.mode})`,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Executor', value: event.executorAddress ?? '(não deployado)', inline: false },
          { name: 'Bot wallet', value: event.account ?? '(dryrun)', inline: false },
        ],
        footer,
      };

    case 'liquidator.shutdown':
      return {
        title: `${emoji} ZEUS Liquidator OFFLINE`,
        description: event.reason,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Uptime', value: `${Math.floor(event.uptimeSec / 60)} min`, inline: true },
        ],
        footer,
      };

    case 'tx.confirmed':
      return {
        title: `${emoji} Liquidation Confirmed — ${event.protocol}`,
        description: event.netProfitUsd !== null
          ? `**Net: $${event.netProfitUsd.toFixed(2)}** (profit $${event.profitUsd?.toFixed(2) ?? 'n/a'} − gas $${event.gasCostUsd.toFixed(2)})`
          : `Profit: ${event.profitUsd?.toFixed(2) ?? 'n/a'} | Gas: $${event.gasCostUsd.toFixed(2)}`,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Borrower', value: shortAddress(event.borrower), inline: true },
          { name: 'Block', value: event.blockNumber, inline: true },
          { name: 'Delta vs esperado', value: `${event.profitDeltaBps > 0 ? '+' : ''}${(event.profitDeltaBps / 100).toFixed(2)}%`, inline: true },
          { name: 'Tx', value: `\`${event.txHash}\``, inline: false },
        ],
        footer,
      };

    case 'tx.reverted_on_chain':
      return {
        title: `${emoji} Tx Revertida — ${event.protocol}`,
        description: `Gas perdido: **$${event.gasUsdLost.toFixed(2)}**`,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Borrower', value: shortAddress(event.borrower), inline: true },
          { name: 'Block', value: event.blockNumber, inline: true },
          { name: 'Tx', value: `\`${event.txHash}\``, inline: false },
        ],
        footer,
      };

    case 'tx.reverted_pre_dispatch':
      return {
        title: `${emoji} Dispatch Descartado — ${event.protocol}`,
        description: event.reason,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Borrower', value: shortAddress(event.borrower), inline: true },
        ],
        footer,
      };

    case 'pnl.kill_switch_triggered':
      return {
        title: `${emoji} KILL SWITCH ATIVADO`,
        description: `Loss 24h **$${event.loss24hUsd.toFixed(2)}** ≥ limit $${event.limitUsd}`,
        color,
        timestamp: event.timestamp,
        fields: event.onChainKillResult
          ? [{ name: 'On-chain kill', value: event.onChainKillResult, inline: true }]
          : undefined,
        footer,
      };

    case 'failure.cooldown_activated':
      return {
        title: `${emoji} Cooldown Ativado`,
        description: `${event.consecutiveFailures} falhas consecutivas — bot pausado por ${event.cooldownSec}s`,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Última falha', value: event.lastFailureReason.slice(0, 256), inline: false },
        ],
        footer,
      };

    case 'failure.cooldown_expired':
      return {
        title: `${emoji} Cooldown Expirou`,
        description: 'Bot retomando operação normal',
        color,
        timestamp: event.timestamp,
        footer,
      };

    case 'gas.alert':
      return {
        title: `${emoji} Gas Reserve ${event.status.toUpperCase()}`,
        description: `Bot wallet ${shortAddress(event.account)} tem **${event.balanceEth} ETH** (≈ $${event.balanceUsd.toFixed(2)})`,
        color,
        timestamp: event.timestamp,
        footer,
      };

    case 'gas.recovered':
      return {
        title: `${emoji} Gas Reserve OK`,
        description: `Wallet recuperou — agora **${event.balanceEth} ETH** ($${event.balanceUsd.toFixed(2)})`,
        color,
        timestamp: event.timestamp,
        footer,
      };

    case 'discovery.tick_completed':
      return {
        title: `${emoji} Tick Completo`,
        description: `Aave: ${event.aavePositions} · Compound: ${event.compoundPositions} · elapsed ${event.elapsedMs}ms`,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Dispatched', value: String(event.dispatched), inline: true },
          { name: 'Dryrun', value: String(event.dryrun), inline: true },
          { name: 'Rejected', value: String(event.rejected), inline: true },
        ],
        footer,
      };

    case 'whale.swap_detected':
      return {
        title: `${emoji} Whale Swap (${event.venue})`,
        description: `**$${event.amountInUsd.toFixed(0)}** swap detectado na mempool`,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'tokenIn', value: shortAddress(event.tokenIn), inline: true },
          { name: 'tokenOut', value: shortAddress(event.tokenOut), inline: true },
          { name: 'Pending tx', value: `\`${event.pendingTxHash}\``, inline: false },
        ],
        footer,
      };

    case 'backrun.opportunity_found':
      return {
        title: `${emoji} Backrun Opportunity`,
        description: `**$${event.expectedProfitUsd.toFixed(2)}** projetado em ${event.pairId}`,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Buy', value: event.buyVenue, inline: true },
          { name: 'Sell', value: event.sellVenue, inline: true },
          { name: 'Slippage', value: `${(event.estimatedSlippageBps / 100).toFixed(2)}%`, inline: true },
          { name: 'Whale tx', value: `\`${event.pendingTxHash}\``, inline: false },
        ],
        footer,
      };

    case 'backrun.dispatched':
      return {
        title: `${emoji} Backrun Submitted`,
        description: `**$${event.expectedProfitUsd.toFixed(2)}** esperado · ${event.pairId}`,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Our tx', value: event.ourTxHash ? `\`${event.ourTxHash}\`` : '(dryrun)', inline: false },
          { name: 'Whale tx', value: `\`${event.pendingTxHash}\``, inline: false },
        ],
        footer,
      };

    case 'backrun.rejected':
      return {
        title: `${emoji} Backrun Rejected (${event.stage})`,
        description: event.reason,
        color,
        timestamp: event.timestamp,
        fields: [
          { name: 'Whale tx', value: `\`${event.pendingTxHash}\``, inline: false },
        ],
        footer,
      };
  }
}

function shortAddress(addr: string): string {
  return `\`${addr.slice(0, 6)}...${addr.slice(-4)}\``;
}

export interface DiscordSinkOpts {
  webhookUrl: string;
  /** Filtro de severidades (default: todas). Use ['warn', 'critical'] pra reduzir spam. */
  severities?: Severity[];
  /** Filtro de tipos (default: todos). Por padrão remove 'discovery.tick_completed' (spam). */
  eventTypes?: ZeusEvent['type'][];
  /** Username customizado pro webhook. */
  username?: string;
  /** Timeout em ms. */
  timeoutMs?: number;
  logger?: LoggerLike;
}

export function createDiscordSink(opts: DiscordSinkOpts) {
  const {
    webhookUrl,
    severities,
    eventTypes,
    username = 'ZEUS Liquidator',
    timeoutMs = 5000,
    logger,
  } = opts;

  // Default: silenciar ticks de discovery (spam alto, 1 por minuto)
  const finalEventTypes = eventTypes ?? (
    [
      'liquidator.boot',
      'liquidator.shutdown',
      'tx.confirmed',
      'tx.reverted_on_chain',
      'pnl.kill_switch_triggered',
      'failure.cooldown_activated',
      'failure.cooldown_expired',
      'gas.alert',
      'gas.recovered',
    ] as ZeusEvent['type'][]
  );

  return async (event: ZeusEvent): Promise<void> => {
    if (severities && !severities.includes(event.severity)) return;
    if (!finalEventTypes.includes(event.type)) return;

    const payload: DiscordPayload = {
      username,
      embeds: [buildEmbed(event)],
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
        logger?.warn(
          { status: res.status, eventType: event.type },
          `Discord webhook retornou ${res.status}`,
        );
      }
    } catch (err) {
      logger?.warn(
        {
          err: err instanceof Error ? err.message : err,
          eventType: event.type,
        },
        `Discord webhook falhou`,
      );
    }
  };
}
