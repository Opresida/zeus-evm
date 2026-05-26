/**
 * Decoder dos eventos `*Executed` do ZeusExecutor.
 *
 * Após uma tx confirmar on-chain, extraímos o profit REAL emitido nos logs.
 * Comparamos com o profit ESTIMADO pelo calculator pra calibração contínua:
 *   - real > expected: pool moveu a favor (raro, MEV positivo)
 *   - real ≈ expected: heuristic está calibrada ✓
 *   - real < expected: slippage maior que estimado → ajustar MAX_SLIPPAGE_BPS
 *
 * Eventos suportados:
 *   - LiquidationExecuted (Aave V3)
 *   - CompoundLiquidationExecuted (Compound III)
 *   - MorphoLiquidationExecuted (Morpho Blue)
 *   - FlashloanArbitrageExecuted (arb com flashloan)
 *   - ArbitrageExecuted (arb com capital próprio)
 */

import {
  decodeEventLog,
  type Address,
  type Log,
  type TransactionReceipt,
} from 'viem';

import { ZEUS_EXECUTOR_ABI } from '@zeus-evm/strategy';

export type LiquidationEventName =
  | 'LiquidationExecuted'
  | 'CompoundLiquidationExecuted'
  | 'MorphoLiquidationExecuted'
  | 'FlashloanArbitrageExecuted'
  | 'ArbitrageExecuted';

const LIQUIDATION_EVENT_NAMES: readonly LiquidationEventName[] = [
  'LiquidationExecuted',
  'CompoundLiquidationExecuted',
  'MorphoLiquidationExecuted',
  'FlashloanArbitrageExecuted',
  'ArbitrageExecuted',
] as const;

export interface DecodedLiquidationEvent {
  /** Nome do evento Solidity */
  eventName: LiquidationEventName;
  /** Profit em wei do token emitido (debt asset, base token ou loan token, depende do evento) */
  profitWei: bigint;
  /** Initiator (operator que disparou) */
  initiator: Address;
  /** Outros campos específicos do evento — útil pra debug/dashboard */
  raw: Record<string, unknown>;
  /** Index do log no receipt (pra rastreio) */
  logIndex: number;
}

/**
 * Extrai os eventos `*Executed` emitidos pelo executor numa tx.
 * Filtra logs pelo address do executor pra ignorar eventos de protocolos (Aave, etc).
 *
 * Retorna o PRIMEIRO match. Numa única tx geralmente só há 1 (a função execute* emite 1 evento).
 */
export function decodeLiquidationEvent(
  receipt: TransactionReceipt,
  executorAddress: Address,
): DecodedLiquidationEvent | null {
  const executorLower = executorAddress.toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== executorLower) continue;
    const decoded = tryDecodeLog(log);
    if (decoded) return decoded;
  }
  return null;
}

function tryDecodeLog(log: Log): DecodedLiquidationEvent | null {
  for (const eventName of LIQUIDATION_EVENT_NAMES) {
    try {
      const decoded = decodeEventLog({
        abi: ZEUS_EXECUTOR_ABI,
        eventName,
        topics: log.topics,
        data: log.data,
      });

      // `decoded.args` é tipado como union; aqui sabemos que tem `profit` (verificado pelos ABIs em abi.ts)
      const args = decoded.args as Record<string, unknown>;
      const profit = args.profit;
      const initiator = args.initiator;
      if (typeof profit !== 'bigint' || typeof initiator !== 'string') continue;

      return {
        eventName,
        profitWei: profit,
        initiator: initiator as Address,
        raw: args,
        logIndex: log.logIndex ?? -1,
      };
    } catch {
      // Não é esse eventName — tenta próximo
      continue;
    }
  }
  return null;
}

/**
 * Calcula diferença relativa entre profit real e esperado em basis points (bps).
 * Positivo = real > expected (favorável). Negativo = real < expected (slippage > estimado).
 */
export function profitDeltaBps(realProfit: bigint, expectedProfit: bigint): number {
  if (expectedProfit === 0n) return 0;
  const delta = realProfit - expectedProfit;
  // bps signed: × 10000 / expected
  return Number((delta * 10_000n) / expectedProfit);
}
