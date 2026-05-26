/**
 * Whale swap subscription — observa pending tx no mempool e detecta swaps grandes
 * que abrem janela de backrun.
 *
 * ⚠️ Estado atual: PLACEHOLDER.
 *
 * Pra subscribir mempool pendente de verdade é preciso:
 *   - Alchemy `alchemy_pendingTransactions` (premium $199/mês) ou
 *   - Blocknative Mempool API ou
 *   - Sequencer público (Base não expõe FCFS mempool premium ainda)
 *
 * Por enquanto este módulo:
 *   - Tem o DECODER calldata funcional (UniV3 + Aerodrome) — testável standalone
 *   - Expõe API `subscribeWhaleSwaps(opts)` que ACEITA um source futuro (WSS / poll)
 *   - O default agora é "no-op": loga aviso e retorna unsubscribe vazio
 *
 * Quando ALCHEMY_MEMPOOL_WSS_URL existir, plugamos aqui sem mexer no resto.
 */

import {
  createPublicClient,
  decodeFunctionData,
  webSocket,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { EventBus } from '../eventBus';
import type { WhaleSwapDetectedEvent } from '../events';
import type { WhaleSwap, WhaleSwapVenue } from '@zeus-evm/strategy';

type AnyPublicClient = PublicClient<any, any>;

// ABIs mínimas dos routers — só as funções que precisamos decodificar.
//
// Uniswap V3 SwapRouter02 — exactInputSingle (single-hop volátil)
const UNIV3_SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'tokenIn' },
          { type: 'address', name: 'tokenOut' },
          { type: 'uint24', name: 'fee' },
          { type: 'address', name: 'recipient' },
          { type: 'uint256', name: 'amountIn' },
          { type: 'uint256', name: 'amountOutMinimum' },
          { type: 'uint160', name: 'sqrtPriceLimitX96' },
        ],
      },
    ],
    outputs: [{ type: 'uint256', name: 'amountOut' }],
  },
] as const;

// Aerodrome Router — swapExactTokensForTokens
const AERODROME_ROUTER_ABI = [
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256', name: 'amountIn' },
      { type: 'uint256', name: 'amountOutMin' },
      {
        type: 'tuple[]',
        name: 'routes',
        components: [
          { type: 'address', name: 'from' },
          { type: 'address', name: 'to' },
          { type: 'bool', name: 'stable' },
          { type: 'address', name: 'factory' },
        ],
      },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'deadline' },
    ],
    outputs: [{ type: 'uint256[]', name: 'amounts' }],
  },
] as const;

// Mapping conhecido dos routers da Base. Decoder usa isso pra saber qual venue.
export interface KnownRouters {
  uniswapV3SwapRouter02: Address;
  uniswapV3UniversalRouter: Address;
  aerodromeRouter: Address;
}

/** Resolve qual venue corresponde ao `to` da pending tx. */
export function classifyVenue(to: Address, routers: KnownRouters): WhaleSwapVenue {
  const target = to.toLowerCase();
  if (
    target === routers.uniswapV3SwapRouter02.toLowerCase() ||
    target === routers.uniswapV3UniversalRouter.toLowerCase()
  ) {
    return 'uniswap-v3';
  }
  if (target === routers.aerodromeRouter.toLowerCase()) return 'aerodrome';
  return 'unknown';
}

/** Resultado parcial do decode — pra alimentar `WhaleSwap`. */
export interface DecodedSwap {
  venue: WhaleSwapVenue;
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
}

/**
 * Tenta decodificar calldata de UniV3 `exactInputSingle` ou Aerodrome
 * `swapExactTokensForTokens`. Retorna null se calldata não corresponde
 * a nenhum dos formatos conhecidos.
 *
 * NOTA: outros métodos (multicall, exactInput multi-hop, universalRouter)
 * NÃO são decodados aqui ainda — fica pro v2 do backrun quando comprovarmos
 * que single-hop já gera fluxo de oportunidades.
 */
export function decodeSwapCalldata(
  to: Address,
  data: Hex,
  routers: KnownRouters,
): DecodedSwap | null {
  const venue = classifyVenue(to, routers);
  if (venue === 'unknown') return null;

  try {
    if (venue === 'uniswap-v3') {
      const decoded = decodeFunctionData({ abi: UNIV3_SWAP_ROUTER_ABI, data });
      if (decoded.functionName !== 'exactInputSingle') return null;
      const p = decoded.args[0];
      return {
        venue: 'uniswap-v3',
        router: to,
        tokenIn: p.tokenIn,
        tokenOut: p.tokenOut,
        amountIn: p.amountIn,
      };
    }

    if (venue === 'aerodrome') {
      const decoded = decodeFunctionData({ abi: AERODROME_ROUTER_ABI, data });
      if (decoded.functionName !== 'swapExactTokensForTokens') return null;
      const [amountIn, , routes] = decoded.args;
      if (!routes || routes.length === 0) return null;
      const first = routes[0]!;
      const last = routes[routes.length - 1]!;
      return {
        venue: 'aerodrome',
        router: to,
        tokenIn: first.from,
        tokenOut: last.to,
        amountIn,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export interface WhaleSwapSubscriptionParams {
  /** WebSocket URL da chain (precisa Alchemy mempool / Blocknative pra mempool real). */
  wsUrl?: string;
  /** Threshold em USD acima do qual o swap conta como "whale". */
  minSwapUsd: number;
  /** Routers conhecidos pra classificação de venue. */
  routers: KnownRouters;
  /** Bus pra emitir WhaleSwapDetectedEvent — backrun-engine subscribe nele. */
  eventBus: EventBus;
  /** Callback de domínio tipado (alternativa ao eventBus). */
  onWhaleSwap?: (whale: WhaleSwap) => void | Promise<void>;
  /** Chain pra eventos. */
  chain: string;
  /** Modo do consumer (dryrun/testnet/mainnet) — propagado pros eventos. */
  mode: 'dryrun' | 'testnet' | 'mainnet';
  /** Helper opcional pra estimar USD de cada swap (token → USD). */
  estimateUsd?: (token: Address, amountIn: bigint) => number | null;
  /** Token decimals lookup (necessário pra alimentar WhaleSwap.decimals fields). */
  resolveDecimals?: (token: Address) => Promise<{ decimals: number; symbol?: string } | null>;
  /** Logger pino-compatible — caller injeta o seu (detector ou backrun-engine). */
  logger: LoggerLike;
}

/**
 * Subscreve mempool pendente. Atualmente é PLACEHOLDER — sem feed premium,
 * apenas registra a intenção de subscrever e retorna unsubscribe vazio.
 *
 * Pra ativar feed real:
 *   1. Configure ALCHEMY_MEMPOOL_WSS_URL no .env (precisa plano Growth+)
 *   2. Substitua o bloco "no-op" abaixo pela subscription real:
 *      `client.transport.subscribe({ method: 'alchemy_pendingTransactions', ... })`
 *   3. Pra cada pending tx: chame `decodeSwapCalldata` → `estimateUsd` → se >= min, emit
 */
export function subscribeWhaleSwaps(params: WhaleSwapSubscriptionParams): () => void {
  const { wsUrl, minSwapUsd, chain, mode, eventBus, logger } = params;

  if (!wsUrl) {
    logger.warn(
      { minSwapUsd },
      `⚠️ whaleSwapSubscription: wsUrl não configurado — PLACEHOLDER ativo (sem feed mempool). ` +
        `Configurar ALCHEMY_MEMPOOL_WSS_URL pra ativar.`,
    );
    return () => {};
  }

  // Subscription real exige Alchemy method `alchemy_pendingTransactions` — não é
  // nativo do viem `watchPendingTransactions` (esse usa `eth_newPendingTransactionFilter`,
  // que NÃO retorna calldata, só hashes — precisaria getTransaction por hash, slow).
  //
  // Implementação completa fica pra quando ativarmos plano Alchemy Growth+. Por enquanto,
  // construímos o client mas avisamos que não fazemos subscribe.

  const wsClient: AnyPublicClient = createPublicClient({
    chain: base,
    transport: webSocket(wsUrl, { retryCount: 5, retryDelay: 1_500 }),
  });

  logger.warn(
    { wsUrl: wsUrl.slice(0, 30) + '...', minSwapUsd },
    `🚧 whaleSwapSubscription: WS conectado mas alchemy_pendingTransactions ainda não plugado. ` +
      `Decoder UniV3+Aerodrome pronto — falta o feed.`,
  );

  // Ainda não emitimos nada — mas reservamos o canal pra próxima iteração.
  void chain;
  void mode;
  void eventBus;
  void wsClient;

  return () => {
    logger.info('Unsubscribing whaleSwapSubscription (placeholder)');
  };
}

/**
 * Helper de teste — emite um WhaleSwap sintético no bus, útil pra validar
 * o pipeline do backrun-engine sem mempool real. Chamado pelo smoke test
 * do backrun-engine.
 */
export function emitSyntheticWhale(
  bus: EventBus,
  whale: WhaleSwap,
  chain: string,
  mode: 'dryrun' | 'testnet' | 'mainnet',
): void {
  const event: WhaleSwapDetectedEvent = {
    type: 'whale.swap_detected',
    timestamp: new Date().toISOString(),
    chain,
    mode,
    severity: 'info',
    pendingTxHash: whale.pendingTxHash,
    venue: whale.venue,
    tokenIn: whale.tokenIn,
    tokenOut: whale.tokenOut,
    amountIn: whale.amountIn.toString(),
    amountInUsd: whale.amountInUsd,
    router: whale.router,
    sender: whale.sender,
  };
  bus.emit(event);
}
