/**
 * StrategyStatsTracker — agregado comparativo por ESTRATÉGIA em janela rolante (default 24h).
 *
 * Alimenta o `strategyStats` do heartbeat → tela "Estratégias" do painel (clássica × pré-liq × filler).
 * O bot conhece a estratégia com precisão, então a comparação não depende de derivar da tabela `events`
 * (onde filler e cross-DEX arb seriam ambos 'arb').
 *
 * - `candidate(strategy, profitUsd)`: viu um candidato LUCRATIVO (vale também em DRY_RUN → mostra o POTENCIAL).
 * - `executed(strategy, netUsd)`: disparou de verdade (0 em DRY_RUN).
 * - `snapshot()`: agrega a janela (poda o que passou de `windowMs`).
 */

import type { HeartbeatStrategyStat } from './events';

export type StrategyKey = HeartbeatStrategyStat['strategy'];

const STRATEGIES: readonly StrategyKey[] = ['classic-liq', 'pre-liq', 'filler'];

interface Entry {
  ts: number;
  usd: number;
}

export interface StrategyStatsTrackerOpts {
  /** Janela rolante em ms (default 24h). */
  windowMs?: number;
  /** Injeção de tempo pra teste determinístico (default Date.now). */
  now?: () => number;
}

export class StrategyStatsTracker {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly candidates = new Map<StrategyKey, Entry[]>();
  private readonly executions = new Map<StrategyKey, Entry[]>();

  constructor(opts: StrategyStatsTrackerOpts = {}) {
    this.windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    for (const s of STRATEGIES) {
      this.candidates.set(s, []);
      this.executions.set(s, []);
    }
  }

  /** Registra um candidato lucrativo (profitUsd = lucro esperado). */
  candidate(strategy: StrategyKey, profitUsd: number): void {
    if (!Number.isFinite(profitUsd)) return;
    this.candidates.get(strategy)?.push({ ts: this.now(), usd: profitUsd });
  }

  /** Registra uma execução real (netUsd = lucro líquido realizado). */
  executed(strategy: StrategyKey, netUsd: number): void {
    if (!Number.isFinite(netUsd)) return;
    this.executions.get(strategy)?.push({ ts: this.now(), usd: netUsd });
  }

  private prune(list: Entry[], cutoff: number): Entry[] {
    // Entradas chegam em ordem de tempo → corta o prefixo expirado.
    let i = 0;
    while (i < list.length && list[i]!.ts < cutoff) i++;
    if (i > 0) list.splice(0, i);
    return list;
  }

  /** Agrega a janela atual por estratégia (poda entradas expiradas). */
  snapshot(): HeartbeatStrategyStat[] {
    const cutoff = this.now() - this.windowMs;
    return STRATEGIES.map((strategy) => {
      const cand = this.prune(this.candidates.get(strategy)!, cutoff);
      const exec = this.prune(this.executions.get(strategy)!, cutoff);
      const round2 = (n: number) => Math.round(n * 100) / 100;
      return {
        strategy,
        candidates24h: cand.length,
        candidateProfitUsd24h: round2(cand.reduce((s, e) => s + e.usd, 0)),
        executed24h: exec.length,
        netUsd24h: round2(exec.reduce((s, e) => s + e.usd, 0)),
      };
    });
  }
}
