/**
 * GasWarDetector — detecta se o bloco corrente está em modo "guerra de gas".
 *
 * 3 sinais combinados (heurística do plano técnico):
 *   1. baseFee corrente / mediana dos últimos N blocos > MULTIPLIER (default 3x)
 *   2. Contagem de pending tx pro mesmo router conhecido > THRESHOLD (default 5)
 *   3. Últimas K dispatches do bot revertaram (failure tracker informa)
 *
 * Output: gasWarLevel ∈ {'normal', 'elevated', 'war'}
 *
 * O bribeCalculator usa esse output pra elevar/reduzir bribeBps. Em 'war' o bot pode
 * elevar até 90%; em 'normal' fica em 30-50%; em 'elevated' fica em 50-70%.
 *
 * NÃO faz polling — caller chama `tick(block)` por novo bloco. Decisão é lock-free.
 */

import type { PublicClient } from 'viem';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

type AnyPublicClient = PublicClient<any, any>;

export type GasWarLevel = 'normal' | 'elevated' | 'war';

export interface GasWarSignals {
  /** baseFee atual / baseFee mediano N blocks atrás (1 = sem mudança, 3 = spike 3x). */
  baseFeeRatio: number;
  /** Quantas tx pending temos detectadas pra routers conhecidos (decoder). */
  pendingTxToKnownRouters: number;
  /** Quantas falhas seguidas o bot teve recente. */
  recentFailures: number;
}

export interface GasWarDetectorOpts {
  /** Quantos blocos passados pra calcular mediana de baseFee (default 10). */
  windowSize?: number;
  /** Multiplier de baseFee que conta como spike (default 2x). */
  spikeMultiplier?: number;
  /** Threshold de pending tx pra mesmo router pra elevar nível (default 5). */
  pendingTxThreshold?: number;
  /** Threshold de falhas consecutivas pra elevar nível (default 2). */
  failureThreshold?: number;
  logger?: LoggerLike;
}

const DEFAULT_WINDOW = 10;
const DEFAULT_SPIKE_MULTIPLIER = 2;
const DEFAULT_PENDING_TX_THRESHOLD = 5;
const DEFAULT_FAILURE_THRESHOLD = 2;

export class GasWarDetector {
  private baseFeeHistory: bigint[] = [];
  private readonly windowSize: number;
  private readonly spikeMultiplier: number;
  private readonly pendingTxThreshold: number;
  private readonly failureThreshold: number;
  private readonly logger: LoggerLike | undefined;

  constructor(opts: GasWarDetectorOpts = {}) {
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW;
    this.spikeMultiplier = opts.spikeMultiplier ?? DEFAULT_SPIKE_MULTIPLIER;
    this.pendingTxThreshold = opts.pendingTxThreshold ?? DEFAULT_PENDING_TX_THRESHOLD;
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.logger = opts.logger;
  }

  /**
   * Registra baseFee de um novo bloco. Chamado pelo block subscription (1 por bloco).
   */
  recordBaseFee(baseFeeWei: bigint): void {
    this.baseFeeHistory.push(baseFeeWei);
    if (this.baseFeeHistory.length > this.windowSize) {
      this.baseFeeHistory.shift();
    }
  }

  /**
   * Calcula o nível de gas war baseado em sinais atuais. O caller passa pending tx
   * count + recent failures como inputs vivos.
   */
  classify(signals: { pendingTxToKnownRouters: number; recentFailures: number }): {
    level: GasWarLevel;
    signals: GasWarSignals;
  } {
    const baseFeeRatio = this._calcBaseFeeRatio();
    const fullSignals: GasWarSignals = {
      baseFeeRatio,
      pendingTxToKnownRouters: signals.pendingTxToKnownRouters,
      recentFailures: signals.recentFailures,
    };

    let activeCount = 0;
    if (baseFeeRatio >= this.spikeMultiplier) activeCount++;
    if (signals.pendingTxToKnownRouters >= this.pendingTxThreshold) activeCount++;
    if (signals.recentFailures >= this.failureThreshold) activeCount++;

    let level: GasWarLevel;
    if (activeCount >= 2) level = 'war';
    else if (activeCount === 1) level = 'elevated';
    else level = 'normal';

    return { level, signals: fullSignals };
  }

  /**
   * baseFee corrente / mediana das últimas N entradas. Retorna 1.0 quando sem histórico.
   * Mediana é mais robusta que mean (resiste a outliers).
   */
  private _calcBaseFeeRatio(): number {
    const history = this.baseFeeHistory;
    if (history.length < 2) return 1;
    const current = history[history.length - 1]!;
    const past = history.slice(0, -1).sort((a, b) => (a < b ? -1 : 1));
    const median = past[Math.floor(past.length / 2)]!;
    if (median === 0n) return 1;
    // Usar Number aqui — baseFee em Base/Arb é sempre < 1 ETH (cabe em Number sem perda)
    return Number(current) / Number(median);
  }

  /**
   * Helper pra polling de baseFee. Caller chama periodicamente.
   * Retorna o baseFee lido pra log/debug.
   */
  async pollBaseFee(client: AnyPublicClient): Promise<bigint | null> {
    try {
      const block = await client.getBlock();
      if (block.baseFeePerGas != null) {
        this.recordBaseFee(block.baseFeePerGas);
        return block.baseFeePerGas;
      }
      return null;
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'gasWarDetector: pollBaseFee falhou',
      );
      return null;
    }
  }
}
