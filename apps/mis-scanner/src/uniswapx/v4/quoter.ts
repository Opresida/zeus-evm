/**
 * Motor 2 / Filler UniswapX — cotação Uniswap V4 (off-chain, F1a).
 *
 * "Descoberta por cotação": em vez de varrer eventos Initialize (lento), tentamos as configs de pool
 * COMUNS (fee/tickSpacing, hooks=0) no V4Quoter — ele reverte se o pool não existe. Pegamos a melhor.
 * Cobre os pools vanilla (blue-chips, onde os líderes roteiam); pools com hooks ficam pra F1b.
 *
 * ⚠️ F1a é SÓ leitura (comparar V4 vs V3 e medir o uplift em DRY_RUN). A EXECUÇÃO V4 é a F1b (on-chain,
 * mexe em fundo — caminho separado e cuidadoso). Aqui não montamos swap V4.
 */

import { encodeFunctionData, decodeFunctionResult, type Address, type PublicClient } from 'viem';

type AnyPublicClient = PublicClient<any, any>;

/** V4Quoter na Base (confirmado on-chain). */
export const V4_QUOTER_BASE = '0x0d5e0F971ED27FBfF6c2837bf31316121532048D' as Address;

/** Configs de pool vanilla mais comuns (fee em pips, tickSpacing). hooks=0. */
export const V4_CANDIDATE_CONFIGS: ReadonlyArray<{ fee: number; tickSpacing: number }> = [
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 100, tickSpacing: 1 },
  { fee: 10000, tickSpacing: 200 },
];

const ZERO_HOOKS = '0x0000000000000000000000000000000000000000' as Address;

export const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          {
            type: 'tuple',
            name: 'poolKey',
            components: [
              { type: 'address', name: 'currency0' },
              { type: 'address', name: 'currency1' },
              { type: 'uint24', name: 'fee' },
              { type: 'int24', name: 'tickSpacing' },
              { type: 'address', name: 'hooks' },
            ],
          },
          { type: 'bool', name: 'zeroForOne' },
          { type: 'uint128', name: 'exactAmount' },
          { type: 'bytes', name: 'hookData' },
        ],
      },
    ],
    outputs: [
      { type: 'uint256', name: 'amountOut' },
      { type: 'uint256', name: 'gasEstimate' },
    ],
  },
] as const;

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Ordena as currencies (V4 exige currency0 < currency1) e diz a direção do swap. */
export function sortCurrencies(
  tokenIn: Address,
  tokenOut: Address,
): { currency0: Address; currency1: Address; zeroForOne: boolean } {
  const inLower = BigInt(tokenIn);
  const outLower = BigInt(tokenOut);
  if (inLower < outLower) {
    return { currency0: tokenIn, currency1: tokenOut, zeroForOne: true };
  }
  return { currency0: tokenOut, currency1: tokenIn, zeroForOne: false };
}

/** Monta a PoolKey + direção pra um par + config. */
export function makeQuoteArgs(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  cfg: { fee: number; tickSpacing: number; hooks?: Address },
) {
  const { currency0, currency1, zeroForOne } = sortCurrencies(tokenIn, tokenOut);
  const poolKey: V4PoolKey = {
    currency0,
    currency1,
    fee: cfg.fee,
    tickSpacing: cfg.tickSpacing,
    hooks: cfg.hooks ?? ZERO_HOOKS,
  };
  return { poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' as const };
}

export interface V4Quote {
  amountOut: bigint;
  poolKey: V4PoolKey;
  zeroForOne: boolean;
}

/**
 * Melhor cotação V4 input→output: varre as configs candidatas via V4Quoter (eth_call), pega a maior saída.
 * Pools inexistentes revertem → ignorados. Retorna null se nenhuma config cotar.
 */
export async function quoteUniswapV4(opts: {
  client: AnyPublicClient;
  quoter?: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  configs?: ReadonlyArray<{ fee: number; tickSpacing: number }>;
}): Promise<V4Quote | null> {
  const { client, quoter = V4_QUOTER_BASE, tokenIn, tokenOut, amountIn, configs = V4_CANDIDATE_CONFIGS } = opts;
  let best: V4Quote | null = null;

  for (const cfg of configs) {
    const args = makeQuoteArgs(tokenIn, tokenOut, amountIn, cfg);
    const data = encodeFunctionData({ abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [args] });
    try {
      const res = await client.call({ to: quoter, data });
      if (!res.data) continue;
      const [amountOut] = decodeFunctionResult({
        abi: V4_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        data: res.data,
      }) as readonly [bigint, bigint];
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) {
        best = { amountOut, poolKey: args.poolKey, zeroForOne: args.zeroForOne };
      }
    } catch {
      // pool inexistente / sem liquidez → revert → próxima config
    }
  }
  return best;
}
