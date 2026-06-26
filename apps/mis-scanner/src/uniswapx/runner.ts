/**
 * Motor 2 / Filler UniswapX — runner (boot-loop). Puxa ordens abertas → avalia → loga candidatos
 * (DRY_RUN) e, se ARMADO + liberado pelo painel, monta + simula (eth_call) + envia ao ZeusUniswapXFiller.
 *
 * Fail-safe igual ao resto do Motor 2: sobe travado; só o toggle remoto + mode != dryrun liberam o envio.
 * O contrato ainda tem minProfitWei + whitelist + kill switch por cima (atômico).
 */

import type { Address, PublicClient, WalletClient } from 'viem';
import { quoteUniswapV3, type Quote } from '@zeus-evm/dex-adapters';
import { cachedQuoteUniswapV3, estimateUsd, type GasOracle } from '@zeus-evm/execution-utils';

import { fetchOpenOrders } from './orderFeed';
import { evaluateFill } from './evaluator';
import { buildFillTx } from './builder';
import { UNISWAPX_REACTORS_BASE } from './abi';
import { quoteUniswapV4, V4_QUOTER_BASE } from './v4/quoter';
import type { NormalizedOrder } from './types';

type AnyPublicClient = PublicClient<any, any>;
type AnyWalletClient = WalletClient<any, any, any>;

const UNI_V3_FEE_TIERS = [500, 3000, 100, 10000];

export interface FillerRunnerDeps {
  client: AnyPublicClient;
  quoterAddress: Address;
  apiBase: string;
  chainId: number;
  minProfitUsd: number;
  gasCostUsd: number;
  ethUsdPrice: number;
  /** Símbolo/decimais por token pra estimateUsd. Mínimo: stables + WETH. */
  tokenMeta: (token: Address) => { symbol: string; decimals: number } | undefined;
  logger: { info: (o: unknown, m?: string) => void; debug?: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  nowSec: () => number;
  // Execução (armado-mas-travado). Ausência de wallet/filler = só DRY_RUN.
  mode: 'dryrun' | 'testnet' | 'mainnet';
  wallet?: AnyWalletClient;
  account?: Address;
  fillerAddress?: Address;
  profitReceiver: Address;
  gasOracle?: GasOracle;
  /** Lido a cada dispatch — toggle remoto do painel (engine_control). */
  liveExecutionEnabled: () => boolean;
  /** V4Quoter (F1a) — compara V3 vs V4 e LOGA o uplift potencial (não executa V4 ainda). */
  v4Quoter?: Address;
  v4QuoteEnabled?: boolean;
}

/** Melhor cotação UniV3 input→output (single-hop, varre fee tiers). V4 entra aqui na F1. */
async function bestQuote(
  d: FillerRunnerDeps,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<Quote | null> {
  const mIn = d.tokenMeta(tokenIn);
  const mOut = d.tokenMeta(tokenOut);
  if (!mIn || !mOut) return null;
  let best: Quote | null = null;
  for (const fee of UNI_V3_FEE_TIERS) {
    const q = await cachedQuoteUniswapV3(
      {
        client: d.client,
        quoterAddress: d.quoterAddress,
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        decimalsIn: mIn.decimals,
        decimalsOut: mOut.decimals,
      },
      quoteUniswapV3,
    );
    if (q && 'amountOut' in q && (!best || q.amountOut > best.amountOut)) best = q;
  }
  return best;
}

const OUR_REACTORS = new Set(
  [UNISWAPX_REACTORS_BASE.v2DutchOrder, UNISWAPX_REACTORS_BASE.v3DutchOrder].map((a) => a.toLowerCase()),
);

/** 1 tick do filler: poll → avalia → log/dispatch. Retorna nº de candidatos lucrativos vistos. */
export async function runFillerTick(d: FillerRunnerDeps): Promise<number> {
  const orders = await fetchOpenOrders({ apiBase: d.apiBase, chainId: d.chainId });
  let candidates = 0;

  for (const order of orders) {
    if (!OUR_REACTORS.has(order.reactor.toLowerCase())) continue;
    // Exclusividade: se a ordem está reservada a OUTRO filler, preencher reverteria → pula.
    if (order.exclusiveFiller && d.account && order.exclusiveFiller.toLowerCase() !== d.account.toLowerCase()) continue;

    let keptQuote: Quote | null = null;
    let v3Out = 0n;
    const evaluation = await evaluateFill(order, {
      quote: async (tokenIn, tokenOut, amountIn) => {
        const q = await bestQuote(d, tokenIn, tokenOut, amountIn);
        keptQuote = q;
        v3Out = q ? q.amountOut : 0n;
        return v3Out > 0n ? v3Out : null;
      },
      estimateUsd: (token, amountWei) => {
        const m = d.tokenMeta(token);
        if (!m) return null;
        return estimateUsd(m.symbol, amountWei, m.decimals, d.ethUsdPrice) ?? null;
      },
      minProfitUsd: d.minProfitUsd,
      gasCostUsd: d.gasCostUsd,
      nowSec: d.nowSec(),
    });

    if (!evaluation.ok || !keptQuote) {
      if (evaluation.reason && d.logger.debug) {
        d.logger.debug({ orderHash: order.orderHash, reason: evaluation.reason }, 'fill descartado');
      }
      continue;
    }
    candidates++;
    d.logger.info(
      { orderHash: order.orderHash, profitToken: evaluation.profitToken, profitUsd: evaluation.profitUsd?.toFixed(2) },
      `🎯 fill candidato: lucro ~$${evaluation.profitUsd?.toFixed(2)}`,
    );

    // F1a — mede o UPLIFT de cobrir V4 (só leitura; execução segue V3 até a F1b).
    if (d.v4QuoteEnabled) {
      try {
        const v4 = await quoteUniswapV4({
          client: d.client,
          quoter: d.v4Quoter ?? V4_QUOTER_BASE,
          tokenIn: order.input.token,
          tokenOut: evaluation.profitToken!,
          amountIn: order.input.amount,
        });
        if (v4 && v4.amountOut > v3Out && v3Out > 0n) {
          const upliftBps = Number(((v4.amountOut - v3Out) * 10_000n) / v3Out);
          d.logger.info(
            { orderHash: order.orderHash, v3Out: v3Out.toString(), v4Out: v4.amountOut.toString(), upliftBps, poolFee: v4.poolKey.fee },
            `🔵 V4 daria +${upliftBps}bps que perdemos hoje (gap p/ F1b)`,
          );
        }
      } catch {
        // cotação V4 best-effort — nunca derruba o tick
      }
    }

    // DRY_RUN ou sem contrato/wallet → só observa.
    if (d.mode === 'dryrun' || !d.fillerAddress || !d.wallet || !d.account) continue;
    // Armado-mas-travado: só dispara se o painel liberou.
    if (!d.liveExecutionEnabled()) continue;

    try {
      const built = buildFillTx(order, {
        fillerAddress: d.fillerAddress,
        profitReceiver: d.profitReceiver,
        quote: keptQuote,
        evaluation,
      });
      // Simula (eth_call) antes de enviar — atômico: se reverter, não gasta.
      await d.client.call({ account: d.account, to: built.to, data: built.data });
      const fees = d.gasOracle ? await d.gasOracle.getFees(d.client) : null;
      const txHash = await d.wallet.sendTransaction({
        account: d.account,
        to: built.to,
        data: built.data,
        chain: d.wallet.chain ?? null,
        ...(fees ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : {}),
      } as never);
      d.logger.info({ orderHash: order.orderHash, txHash }, '📤 fill submetido');
    } catch (err) {
      d.logger.warn(
        { orderHash: order.orderHash, err: err instanceof Error ? err.message : err },
        'fill abortado (simulação/envio falhou)',
      );
    }
  }
  return candidates;
}
