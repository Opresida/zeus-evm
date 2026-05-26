/**
 * Scraper state — persistido em disk pra controle remoto futuro via front-end.
 *
 * Quando o APK/front mobile for construído, ele edita esse JSON via API REST
 * simples (`POST /scraper/control`) e o scraper respeita config no próximo run.
 *
 * Por enquanto, controle é via env var ou edição direta do state.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

export type ScheduleMode = 'manual' | 'hourly' | 'every_2h' | 'every_6h' | 'every_12h' | 'daily';

export interface ScraperState {
  version: 1;
  /** Se false, scraper não roda (próximo cron tick pula execução). */
  enabled: boolean;
  /** Frequência de execução. Default every_12h = 2x/dia. */
  schedule: ScheduleMode;
  /** Chains que o scraper processa. Outras são ignoradas. */
  activeChains: string[]; // ex: ['base', 'optimism', 'arbitrum']
  /** Último run timestamp ISO. */
  lastRunAt: string | null;
  /** Próximo run agendado ISO. */
  nextRunAt: string | null;
  /** Stats últimas 24h (atualizado pelo orchestrator). */
  stats24h: {
    poolsAnalyzed: number;
    candidatesQualified: number;
    newDiscoveries: number;
    topScore: number;
    topPair: string | null;
  };
}

const DEFAULT_STATE: ScraperState = {
  version: 1,
  enabled: true,
  schedule: 'every_12h',
  activeChains: ['base', 'optimism', 'arbitrum', 'polygon_pos', 'avax'],
  lastRunAt: null,
  nextRunAt: null,
  stats24h: {
    poolsAnalyzed: 0,
    candidatesQualified: 0,
    newDiscoveries: 0,
    topScore: 0,
    topPair: null,
  },
};

export class StateManager {
  private state: ScraperState = DEFAULT_STATE;
  private statePath: string;
  private logger: LoggerLike | undefined;

  constructor(stateFilePath: string, logger?: LoggerLike) {
    this.statePath = stateFilePath;
    this.logger = logger;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) {
      const dir = dirname(this.statePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.persist();
      this.logger?.info({ path: this.statePath }, '📁 State file criado com defaults');
      return;
    }

    try {
      const raw = readFileSync(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ScraperState>;
      if (parsed.version === 1) {
        this.state = { ...DEFAULT_STATE, ...parsed };
        this.logger?.debug({ enabled: this.state.enabled, schedule: this.state.schedule }, '📂 State carregado');
      }
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'State file corrompido, usando defaults',
      );
    }
  }

  persist(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.logger?.error(
        { err: err instanceof Error ? err.message : err },
        'Falha ao persistir state',
      );
    }
  }

  get(): ScraperState {
    return { ...this.state };
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  getActiveChains(): readonly string[] {
    return this.state.activeChains;
  }

  setEnabled(enabled: boolean): void {
    this.state.enabled = enabled;
    this.persist();
    this.logger?.info({ enabled }, `🔘 Scraper ${enabled ? 'ATIVADO' : 'DESATIVADO'}`);
  }

  setSchedule(schedule: ScheduleMode): void {
    this.state.schedule = schedule;
    this.recalcNextRun();
    this.persist();
    this.logger?.info({ schedule, nextRunAt: this.state.nextRunAt }, '⏰ Schedule atualizado');
  }

  setActiveChains(chains: string[]): void {
    this.state.activeChains = chains;
    this.persist();
    this.logger?.info({ activeChains: chains }, '🌐 Chains ativas atualizadas');
  }

  updateAfterRun(stats: ScraperState['stats24h']): void {
    this.state.lastRunAt = new Date().toISOString();
    this.recalcNextRun();
    this.state.stats24h = stats;
    this.persist();
  }

  private recalcNextRun(): void {
    if (!this.state.lastRunAt) {
      this.state.nextRunAt = null;
      return;
    }
    const last = new Date(this.state.lastRunAt).getTime();
    const intervalMs = scheduleIntervalMs(this.state.schedule);
    this.state.nextRunAt = intervalMs > 0 ? new Date(last + intervalMs).toISOString() : null;
  }
}

function scheduleIntervalMs(schedule: ScheduleMode): number {
  switch (schedule) {
    case 'hourly': return 60 * 60 * 1000;
    case 'every_2h': return 2 * 60 * 60 * 1000;
    case 'every_6h': return 6 * 60 * 60 * 1000;
    case 'every_12h': return 12 * 60 * 60 * 1000;
    case 'daily': return 24 * 60 * 60 * 1000;
    case 'manual': return 0;
    default: return 0;
  }
}
