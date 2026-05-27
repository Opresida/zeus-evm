/**
 * SlippageRealTracker — Item 10 P2.
 *
 * Decoda eventos Swap (UniV3 + Aerodrome) de receipt pra extrair `amountOut` real.
 * Slippage real = (expected - real) / expected em bps.
 *
 * Por que isso importa: calculator ESTIMA slippage via quote pré-tx, mas estado
 * do pool muda entre quote e execução. Slippage real é o único números que conta.
 *
 * Suporta:
 *  - UniswapV3 Pool: event `Swap(sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)`
 *  - Aerodrome Pool: event `Swap(sender, to, amount0In, amount1In, amount0Out, amount1Out)` (similar UniV2)
 */

import { decodeEventLog, type Log } from 'viem';

// UniswapV3 Pool Swap event signature (topic[0])
// keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
const UNIV3_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as const;

// Aerodrome (Velodrome V2) Pool Swap event signature
// keccak256("Swap(address,address,uint256,uint256,uint256,uint256)")
const AERODROME_SWAP_TOPIC = '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b' as const;

const UNIV3_SWAP_ABI = [
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { type: 'address', name: 'sender', indexed: true },
      { type: 'address', name: 'recipient', indexed: true },
      { type: 'int256', name: 'amount0' },
      { type: 'int256', name: 'amount1' },
      { type: 'uint160', name: 'sqrtPriceX96' },
      { type: 'uint128', name: 'liquidity' },
      { type: 'int24', name: 'tick' },
    ],
  },
] as const;

const AERODROME_SWAP_ABI = [
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { type: 'address', name: 'sender', indexed: true },
      { type: 'address', name: 'to', indexed: true },
      { type: 'uint256', name: 'amount0In' },
      { type: 'uint256', name: 'amount1In' },
      { type: 'uint256', name: 'amount0Out' },
      { type: 'uint256', name: 'amount1Out' },
    ],
  },
] as const;

export interface DecodedSwapReceipt {
  venue: 'uniswap-v3' | 'aerodrome';
  pool: `0x${string}`;
  amount_in: bigint;
  amount_out: bigint;
  /** Direção da swap (qual token foi tokenOut). True = token1, False = token0. */
  zero_for_one: boolean;
}

/**
 * Itera logs do receipt e retorna o ÚLTIMO swap relevante (geralmente o final
 * em multi-hop = output que queríamos).
 *
 * Retorna null se nenhum Swap relevante encontrado.
 */
export function decodeLastSwap(logs: readonly Log[]): DecodedSwapReceipt | null {
  // Itera de trás pra frente pra pegar swap mais recente
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i];
    if (!log || !log.topics || log.topics.length === 0) continue;
    const topic0 = log.topics[0];

    // UniV3
    if (topic0 === UNIV3_SWAP_TOPIC) {
      try {
        const decoded = decodeEventLog({
          abi: UNIV3_SWAP_ABI,
          data: log.data,
          topics: log.topics,
        });
        const amount0 = decoded.args.amount0 as bigint;
        const amount1 = decoded.args.amount1 as bigint;
        // UniV3: amount positivo = saída do pool (tokenOut), negativo = entrada
        // Na perspectiva do pool, positive = received from user
        // Simplification: zero_for_one = amount0 > 0 (vendeu token0 pro pool)
        const zero_for_one = amount0 > 0n;
        const amount_in = zero_for_one ? amount0 : amount1;
        const amount_out = zero_for_one ? -amount1 : -amount0;
        return {
          venue: 'uniswap-v3',
          pool: log.address,
          amount_in: amount_in > 0n ? amount_in : -amount_in,
          amount_out: amount_out > 0n ? amount_out : -amount_out,
          zero_for_one,
        };
      } catch {
        continue;
      }
    }

    // Aerodrome (UniV2-like)
    if (topic0 === AERODROME_SWAP_TOPIC) {
      try {
        const decoded = decodeEventLog({
          abi: AERODROME_SWAP_ABI,
          data: log.data,
          topics: log.topics,
        });
        const a0in = decoded.args.amount0In as bigint;
        const a1in = decoded.args.amount1In as bigint;
        const a0out = decoded.args.amount0Out as bigint;
        const a1out = decoded.args.amount1Out as bigint;
        const zero_for_one = a0in > 0n;
        return {
          venue: 'aerodrome',
          pool: log.address,
          amount_in: zero_for_one ? a0in : a1in,
          amount_out: zero_for_one ? a1out : a0out,
          zero_for_one,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Calcula slippage em bps.
 *   slippage_bps = (expected - real) / expected * 10000
 *
 * Retorna 0 se expected <= 0 (defensivo).
 */
export function calculateSlippageBps(expectedAmountOut: bigint, realAmountOut: bigint): number {
  if (expectedAmountOut <= 0n) return 0;
  if (realAmountOut >= expectedAmountOut) return 0; // sem slippage (recebeu mais ou igual)
  const delta = expectedAmountOut - realAmountOut;
  // bps = delta / expected * 10000
  return Number((delta * 10_000n) / expectedAmountOut);
}
