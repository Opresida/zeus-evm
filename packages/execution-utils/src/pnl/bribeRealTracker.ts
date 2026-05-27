/**
 * BribeRealTracker — Item 10 P3.
 *
 * Decoda event `BribePaid` do BribeManager pra extrair quanto de WETH foi
 * REALMENTE pago ao coinbase (vs estimado pré-tx).
 *
 * Também detecta `BribeCoinbaseFallback` (B-6 fix): coinbase recusou ETH,
 * fallback enviou WETH ao operator. Nesse caso, bribe_native_wei foi "perdido"
 * em termos de tip de inclusion mas profit foi preservado.
 */

import { decodeEventLog, type Log } from 'viem';

// keccak256("BribePaid(address,uint8,address,uint256,uint256,uint256)")
const BRIBE_PAID_TOPIC = '0x21f7b3da64f2017fde2acf95dba2a14e3acdc1b5b1f80a3e8df2dc3aac0bdde7' as const;

// keccak256("BribeCoinbaseFallback(address,uint8,address,address,uint256,uint256)")
const BRIBE_FALLBACK_TOPIC = '0x6b1efdf52c0b9b48c0a3da9b1c97e30000fa17e2c7e1c98a3a3e8ee9a23f3a64' as const;

const BRIBE_PAID_ABI = [
  {
    type: 'event',
    name: 'BribePaid',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'uint8', name: 'opType', indexed: true },
      { type: 'address', name: 'coinbase', indexed: true },
      { type: 'uint256', name: 'bribeNativeWei' },
      { type: 'uint256', name: 'grossProfit' },
      { type: 'uint256', name: 'netProfit' },
    ],
  },
] as const;

const BRIBE_FALLBACK_ABI = [
  {
    type: 'event',
    name: 'BribeCoinbaseFallback',
    inputs: [
      { type: 'address', name: 'initiator', indexed: true },
      { type: 'uint8', name: 'opType', indexed: true },
      { type: 'address', name: 'coinbase', indexed: true },
      { type: 'address', name: 'recipient' },
      { type: 'uint256', name: 'bribeNativeWei' },
      { type: 'uint256', name: 'grossProfit' },
    ],
  },
] as const;

export interface DecodedBribe {
  /** True se BribePaid, false se BribeCoinbaseFallback. */
  delivered: boolean;
  bribe_native_wei: bigint;
  gross_profit: bigint;
  net_profit?: bigint;            // só presente em BribePaid (path normal)
  coinbase: `0x${string}`;
  /** Em fallback, quem recebeu o WETH re-wrapped. */
  fallback_recipient?: `0x${string}`;
}

/**
 * Decoda eventos de bribe do receipt. Retorna a primeira ocorrência
 * (geralmente 1 por tx).
 */
export function decodeBribeEvent(logs: readonly Log[]): DecodedBribe | null {
  for (const log of logs) {
    if (!log || !log.topics || log.topics.length === 0) continue;
    const topic0 = log.topics[0];

    if (topic0 === BRIBE_PAID_TOPIC) {
      try {
        const decoded = decodeEventLog({
          abi: BRIBE_PAID_ABI,
          data: log.data,
          topics: log.topics,
        });
        return {
          delivered: true,
          bribe_native_wei: decoded.args.bribeNativeWei as bigint,
          gross_profit: decoded.args.grossProfit as bigint,
          net_profit: decoded.args.netProfit as bigint,
          coinbase: decoded.args.coinbase as `0x${string}`,
        };
      } catch {
        continue;
      }
    }

    if (topic0 === BRIBE_FALLBACK_TOPIC) {
      try {
        const decoded = decodeEventLog({
          abi: BRIBE_FALLBACK_ABI,
          data: log.data,
          topics: log.topics,
        });
        return {
          delivered: false,
          bribe_native_wei: decoded.args.bribeNativeWei as bigint,
          gross_profit: decoded.args.grossProfit as bigint,
          coinbase: decoded.args.coinbase as `0x${string}`,
          fallback_recipient: decoded.args.recipient as `0x${string}`,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}
