/**
 * PnL Tracker — rolling window 24h de wins/losses + kill switch automático.
 *
 * Em flashloan-only mode, "loss" se reduz a:
 *   - Gas gasto em tx que reverteu on-chain (após submit)
 *   - Tx confirmada com profit líquido negativo (raro mas possível)
 *
 * Tx revertida pre-dispatch (gate de simulação) NÃO conta como loss — não custou gas.
 *
 * Persistência: append-only JSONL em logs/pnl-events.jsonl. No boot, carrega
 * eventos das últimas 24h. Sobrevive restart sem perder histórico.
 *
 * Kill switch automático:
 *   - Quando loss acumulado 24h > DAILY_LOSS_LIMIT_USD → aciona kill state
 *   - Modo DRY_RUN: só estado interno (não submete tx)
 *   - Modo testnet/mainnet: chama executor.kill() on-chain via owner wallet
 *   - Idempotente: chamar 2x não causa problema
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LoggerLike } from '@zeus-evm/aave-discovery';

/** Janela rolante em ms (24h fixo — não configurável pra evitar "tunar" o limit em produção). */
const WINDOW_MS = 24 * 60 * 60 * 1000;

export type PnlEventType = 'win' | 'loss';

export interface PnlEvent {
  /** Unix ms timestamp */
  timestamp: number;
  type: PnlEventType;
  /** Valor em USD (sempre positivo — type discrimina sinal) */
  amountUsd: number;
  txHash?: `0x${string}`;
  chain?: string;
  /** Origem da operação. Suporta liquidator (3 protocolos) + backrun. */
  protocol?: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'backrun';
  reason?: string;
}

export interface PnlStats {
  windowMs: number;
  totalEvents: number;
  wins: number;
  losses: number;
  winsUsd: number;
  lossesUsd: number;
  netPnlUsd: number;
  killSwitchTriggered: boolean;
  killSwitchAt?: number;
  killSwitchReason?: string;
}

export interface PnlTrackerOpts {
  dailyLossLimitUsd: number;
  logFilePath: string;
  /** Se true, chama kill() on-chain quando limit atingido. Em dryrun, fica false. */
  autoKillEnabled: boolean;
  logger?: LoggerLike;
}

export class PnlTracker {
  private events: PnlEvent[] = [];
  private dailyLossLimitUsd: number;
  private logFilePath: string;
  private autoKillEnabled: boolean;
  private logger: LoggerLike | undefined;

  private _killTriggered = false;
  private _killAt: number | undefined;
  private _killReason: string | undefined;

  constructor(opts: PnlTrackerOpts) {
    this.dailyLossLimitUsd = opts.dailyLossLimitUsd;
    this.logFilePath = opts.logFilePath;
    this.autoKillEnabled = opts.autoKillEnabled;
    this.logger = opts.logger;
    this.ensureLogDir();
    this.loadFromDisk();
  }

  private ensureLogDir(): void {
    const dir = dirname(this.logFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.logFilePath)) return;
    try {
      const content = readFileSync(this.logFilePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const cutoff = Date.now() - WINDOW_MS;
      let loaded = 0;
      for (const line of lines) {
        try {
          const evt = JSON.parse(line) as PnlEvent;
          if (typeof evt.timestamp === 'number' && evt.timestamp >= cutoff) {
            this.events.push(evt);
            loaded++;
          }
        } catch {
          // linha corrompida — skip
        }
      }
      this.logger?.info(
        { loaded, file: this.logFilePath },
        `📂 PnL tracker: ${loaded} eventos carregados (últimas 24h)`,
      );
      // Check kill switch após reload (pode estar acima do limit pós-restart)
      this.checkKillSwitch();
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'Falha ao carregar PnL log — começando do zero',
      );
    }
  }

  private append(event: PnlEvent): void {
    this.events.push(event);
    try {
      appendFileSync(this.logFilePath, JSON.stringify(event) + '\n');
    } catch (err) {
      this.logger?.error(
        { err: err instanceof Error ? err.message : err },
        'Falha ao persistir PnL event — continuando em memória',
      );
    }
    this.checkKillSwitch();
  }

  pruneOld(): number {
    const cutoff = Date.now() - WINDOW_MS;
    const before = this.events.length;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
    return before - this.events.length;
  }

  recordWin(
    amountUsd: number,
    meta: { txHash: `0x${string}`; chain: string; protocol?: PnlEvent['protocol'] },
  ): void {
    if (amountUsd <= 0) return;
    this.append({ timestamp: Date.now(), type: 'win', amountUsd, ...meta });
  }

  recordLoss(
    amountUsd: number,
    meta: {
      txHash?: `0x${string}`;
      chain?: string;
      protocol?: PnlEvent['protocol'];
      reason: string;
    },
  ): void {
    if (amountUsd <= 0) return;
    this.append({ timestamp: Date.now(), type: 'loss', amountUsd, ...meta });
  }

  stats(): PnlStats {
    this.pruneOld();
    let wins = 0;
    let losses = 0;
    let winsUsd = 0;
    let lossesUsd = 0;
    for (const e of this.events) {
      if (e.type === 'win') {
        wins++;
        winsUsd += e.amountUsd;
      } else {
        losses++;
        lossesUsd += e.amountUsd;
      }
    }
    return {
      windowMs: WINDOW_MS,
      totalEvents: this.events.length,
      wins,
      losses,
      winsUsd,
      lossesUsd,
      netPnlUsd: winsUsd - lossesUsd,
      killSwitchTriggered: this._killTriggered,
      killSwitchAt: this._killAt,
      killSwitchReason: this._killReason,
    };
  }

  currentLoss24h(): number {
    this.pruneOld();
    return this.events.filter((e) => e.type === 'loss').reduce((sum, e) => sum + e.amountUsd, 0);
  }

  private checkKillSwitch(): void {
    if (this._killTriggered) return;
    const loss = this.currentLoss24h();
    if (loss >= this.dailyLossLimitUsd) {
      this._killTriggered = true;
      this._killAt = Date.now();
      this._killReason = `Loss 24h $${loss.toFixed(2)} >= limit $${this.dailyLossLimitUsd}`;
      this.logger?.fatal(
        {
          loss24h: loss.toFixed(2),
          limit: this.dailyLossLimitUsd,
          autoKillEnabled: this.autoKillEnabled,
        },
        `🚨 KILL SWITCH ACIONADO — loss 24h $${loss.toFixed(2)} ultrapassou limite $${this.dailyLossLimitUsd}`,
      );
    }
  }

  isKillSwitchTriggered(): boolean {
    return this._killTriggered;
  }

  killReason(): string | undefined {
    return this._killReason;
  }

  isAutoKillEnabled(): boolean {
    return this.autoKillEnabled;
  }

  manualReset(reason: string): void {
    this.logger?.warn({ reason }, `⚠️ PnL tracker MANUAL RESET — ${reason}`);
    this._killTriggered = false;
    this._killAt = undefined;
    this._killReason = undefined;
  }
}
