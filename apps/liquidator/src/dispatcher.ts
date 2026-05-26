/**
 * Dispatcher — submete tx ao RPC conforme o modo configurado.
 *
 * Modos:
 *   - dryrun: NÃO submete. Apenas loga o que faria. Read-only.
 *   - testnet: submete em chain Sepolia (Base/Arb/OP). Gas testnet.
 *   - mainnet: submete em chain mainnet. Gas real. ⚠️ requer KILL_SWITCH=false explícito.
 *
 * Em todos os modos, simulação eth_call é feita ANTES (decisão de submeter).
 * Se a simulação falhar, descarta antes de queimar gas.
 */

import type { Address, Hex, WalletClient, PublicClient } from 'viem';

import { logger } from './logger';
import type { LiquidatorMode } from './config';
import type { DispatchOutcome } from './types';
import { decodeLiquidationEvent, profitDeltaBps } from './eventDecoder';
import { estimateUsd, formatWei, gasCostUsd } from './priceUtils';
import type { PnlTracker, PnlEvent } from './pnlTracker';
import type { FailureTracker } from './failureTracker';

type AnyPublicClient = PublicClient<any, any>;
type AnyWalletClient = WalletClient<any, any, any>;

export interface DispatchInput {
  mode: LiquidatorMode;
  client: AnyPublicClient;
  /** Undefined em dryrun. Obrigatório em testnet/mainnet. */
  wallet?: AnyWalletClient;
  /** Bot account address (do wallet) */
  account?: Address;
  /** Endereço do contrato ZeusExecutor */
  to: Address;
  /** Calldata pronta */
  data: Hex;
  /** Resumo pra logging contextual */
  summary: Record<string, unknown>;
  /** Confirmação de simulação prévia (true = pré-flight passou) */
  simulationOk: boolean;
  simulationGas?: bigint;
  simulationReason?: string;
  /** Profit esperado em wei do debt asset — pra comparação real vs estimado pós-confirmação. */
  expectedProfitWei: bigint;
  /** Decimais do asset onde o profit é pago (USDC=6, WETH=18, etc) — pra formatação humana. */
  profitAssetDecimals: number;
  /** Symbol do asset onde o profit é pago — pra USD estimate via stable peg / ETH price. */
  profitAssetSymbol: string;
  /** Preço ETH/USD estimado pra calcular gasCostUsd (do config). */
  ethUsdPrice: number;
  /** PnL tracker pra registrar wins/losses e acionar kill switch automático. */
  pnlTracker?: PnlTracker;
  /** Failure tracker pra contar falhas consecutivas e ativar cooldown. */
  failureTracker?: FailureTracker;
  /** Protocolo da operação — pra registrar no PnL event. */
  protocol?: PnlEvent['protocol'];
}

/**
 * Despacha a tx conforme o modo.
 * - Se `simulationOk=false`: aborta independente do modo, retorna `reverted_pre_dispatch`.
 * - Se mode=`dryrun`: loga e retorna `dryrun_skipped`.
 * - Senão: submete via wallet.sendRawTransaction.
 */
export async function dispatch(input: DispatchInput): Promise<DispatchOutcome> {
  const {
    mode,
    client,
    wallet,
    account,
    to,
    data,
    summary,
    simulationOk,
    simulationGas,
    simulationReason,
    expectedProfitWei,
    profitAssetDecimals,
    profitAssetSymbol,
    ethUsdPrice,
    pnlTracker,
    failureTracker,
    protocol,
  } = input;

  const chainName = typeof summary.chain === 'string' ? summary.chain : 'unknown';

  // Gate 1: simulação tem que ter passado
  if (!simulationOk) {
    logger.warn(
      { ...summary, simulationReason },
      `❌ Dispatch ABORTADO — simulation falhou: ${simulationReason}`,
    );
    return { status: 'reverted_pre_dispatch', reason: simulationReason ?? 'unknown' };
  }

  // Gate 2: dryrun mode
  if (mode === 'dryrun') {
    logger.info(
      { ...summary, gasEstimate: simulationGas?.toString() },
      `🟦 DRY_RUN: tx VÁLIDA (não submetida). Gas estimado: ${simulationGas?.toString() ?? 'n/a'}`,
    );
    return { status: 'dryrun_skipped', reason: 'mode=dryrun' };
  }

  // Gate 3: wallet obrigatória em testnet/mainnet
  if (!wallet || !account) {
    logger.error({ ...summary }, 'Wallet ausente em modo testnet/mainnet — abortando');
    return { status: 'reverted_pre_dispatch', reason: 'wallet missing in non-dryrun mode' };
  }

  // Submete
  try {
    logger.info({ ...summary, mode }, `🚀 SUBMETENDO tx (${mode})...`);
    const txHash = await wallet.sendTransaction({
      account,
      to,
      data,
      // chain é resolvida via wallet.chain
      chain: wallet.chain ?? null,
    } as any);

    logger.info({ ...summary, txHash, mode }, `📤 Tx submetida: ${txHash}`);

    // Aguarda confirmação
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });

    if (receipt.status === 'reverted') {
      // Gas perdido em tx revertida = LOSS pra PnL tracker (em USD)
      const revertGasUsd = gasCostUsd(receipt.gasUsed, receipt.effectiveGasPrice ?? 0n, ethUsdPrice);
      pnlTracker?.recordLoss(revertGasUsd, {
        txHash,
        chain: chainName,
        protocol,
        reason: `reverted on-chain at block ${receipt.blockNumber}`,
      });
      // Contagem de falha consecutiva — cooldown automático após N falhas
      failureTracker?.recordFailure(`reverted on-chain ${txHash}`);
      logger.error(
        {
          ...summary,
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          gasUsdLost: revertGasUsd.toFixed(4),
        },
        `💥 Tx REVERTIDA on-chain: ${txHash} | gas perdido $${revertGasUsd.toFixed(4)}`,
      );
      return {
        status: 'reverted_on_chain',
        txHash,
        reason: `reverted at block ${receipt.blockNumber}`,
      };
    }

    // Decode profit REAL do event LiquidationExecuted (ou *Executed)
    const decoded = decodeLiquidationEvent(receipt, to);
    const realProfit = decoded?.profitWei ?? 0n;
    const deltaBps = profitDeltaBps(realProfit, expectedProfitWei);

    // Formatação humana — wei → "12.45" + USD
    const profitFormatted = formatWei(realProfit, profitAssetDecimals);
    const profitUsd = estimateUsd(profitAssetSymbol, realProfit, profitAssetDecimals, ethUsdPrice);
    const gasUsdCost = gasCostUsd(receipt.gasUsed, receipt.effectiveGasPrice ?? 0n, ethUsdPrice);
    const netProfitUsd = profitUsd !== undefined ? profitUsd - gasUsdCost : undefined;

    // Log calibração — discrepância real vs esperado vira sinal pra ajustar thresholds
    const calibrationNote =
      deltaBps >= -100 && deltaBps <= 100
        ? '🎯 dentro da banda ±1%'
        : deltaBps > 100
          ? `🟢 +${(deltaBps / 100).toFixed(2)}% acima do esperado (MEV favorável OR underestimate)`
          : `🟠 ${(deltaBps / 100).toFixed(2)}% abaixo (slippage > estimado, revisar MAX_SLIPPAGE_BPS)`;

    const profitLabel = profitUsd !== undefined
      ? `💰 profit=$${profitUsd.toFixed(2)} (gas $${gasUsdCost.toFixed(2)}, líquido $${(netProfitUsd ?? 0).toFixed(2)})`
      : `💰 profit=${profitFormatted} ${profitAssetSymbol} (gas $${gasUsdCost.toFixed(2)})`;

    logger.info(
      {
        ...summary,
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        gasCostUsd: gasUsdCost.toFixed(4),
        eventName: decoded?.eventName,
        realProfitWei: realProfit.toString(),
        realProfitFormatted: `${profitFormatted} ${profitAssetSymbol}`,
        realProfitUsd: profitUsd !== undefined ? profitUsd.toFixed(4) : 'n/a',
        netProfitUsd: netProfitUsd !== undefined ? netProfitUsd.toFixed(4) : 'n/a',
        expectedProfitWei: expectedProfitWei.toString(),
        profitDeltaBps: deltaBps,
        calibration: calibrationNote,
      },
      `✅ Tx CONFIRMED ${txHash} | ${profitLabel} | ${calibrationNote}`,
    );

    // Registra PnL: net positivo = win, net negativo = loss (raro mas possível)
    if (netProfitUsd !== undefined && pnlTracker) {
      if (netProfitUsd > 0) {
        pnlTracker.recordWin(netProfitUsd, { txHash, chain: chainName, protocol });
      } else if (netProfitUsd < 0) {
        pnlTracker.recordLoss(Math.abs(netProfitUsd), {
          txHash,
          chain: chainName,
          protocol,
          reason: `confirmed but net negative (profit=$${(profitUsd ?? 0).toFixed(2)}, gas=$${gasUsdCost.toFixed(2)})`,
        });
      }
    }

    // Contagem consecutiva: net positivo reseta, net negativo conta como falha
    if (netProfitUsd !== undefined && failureTracker) {
      if (netProfitUsd > 0) {
        failureTracker.recordSuccess();
      } else if (netProfitUsd < 0) {
        failureTracker.recordFailure(`confirmed but net negative ($${netProfitUsd.toFixed(2)})`);
      }
    } else if (failureTracker) {
      // Confirmed sem net calculável (token desconhecido pra USD) — tratamos como success
      failureTracker.recordSuccess();
    }

    return {
      status: 'confirmed',
      txHash,
      profitWei: realProfit,
      expectedProfitWei,
      profitDeltaBps: deltaBps,
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
      eventName: decoded?.eventName,
      profitFormatted: `${profitFormatted} ${profitAssetSymbol}`,
      profitUsd,
      gasCostUsd: gasUsdCost,
      netProfitUsd,
      profitAssetSymbol,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ ...summary, err: msg }, `💥 Dispatch falhou: ${msg.slice(0, 200)}`);
    return { status: 'reverted_pre_dispatch', reason: msg.slice(0, 200) };
  }
}

/**
 * Helper pra acionar kill() on-chain quando PnL tracker detecta loss > limit.
 *
 * Idempotente — pode ser chamado várias vezes sem problema. Se já está killed,
 * retorna `already_killed` sem submeter tx duplicada.
 *
 * Em DRY_RUN: NÃO submete tx (estado interno do tracker é suficiente pra parar dispatches).
 * Em testnet/mainnet: submete `kill()` se wallet for owner.
 */
export interface KillSwitchOnChainResult {
  status: 'submitted' | 'already_killed' | 'dryrun_skipped' | 'no_wallet' | 'failed';
  txHash?: `0x${string}`;
  reason?: string;
}

const EXECUTOR_KILL_ABI = [
  {
    type: 'function',
    name: 'kill',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isKilled',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
] as const;

export async function triggerKillSwitchOnChain(opts: {
  mode: LiquidatorMode;
  client: AnyPublicClient;
  wallet?: AnyWalletClient;
  account?: Address;
  executorAddress: Address;
  reason: string;
}): Promise<KillSwitchOnChainResult> {
  const { mode, client, wallet, account, executorAddress, reason } = opts;

  if (mode === 'dryrun') {
    logger.warn(
      { executorAddress, reason },
      `🟦 DRY_RUN: kill() NÃO submetido on-chain (estado interno do tracker bloqueia dispatches)`,
    );
    return { status: 'dryrun_skipped', reason: 'mode=dryrun' };
  }

  if (!wallet || !account) {
    logger.error({ executorAddress }, 'Kill on-chain abortado — wallet ausente');
    return { status: 'no_wallet', reason: 'wallet missing in non-dryrun mode' };
  }

  try {
    // Idempotência: ler estado atual antes de submeter
    const alreadyKilled = (await client.readContract({
      address: executorAddress,
      abi: EXECUTOR_KILL_ABI,
      functionName: 'isKilled',
    })) as boolean;

    if (alreadyKilled) {
      logger.warn(
        { executorAddress, reason },
        `Contrato JÁ está killed on-chain — skip tx duplicada`,
      );
      return { status: 'already_killed', reason: 'isKilled() returned true' };
    }

    logger.fatal(
      { executorAddress, reason, mode },
      `🚨 SUBMETENDO kill() ON-CHAIN — ${reason}`,
    );

    const txHash = await wallet.writeContract({
      address: executorAddress,
      abi: EXECUTOR_KILL_ABI,
      functionName: 'kill',
      account,
      chain: wallet.chain ?? null,
    } as any);

    logger.fatal({ executorAddress, txHash }, `🚨 kill() submetido — txHash=${txHash}`);

    // Aguarda confirmação (não bloqueia futuras decisões, mas confirma)
    await client.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    logger.fatal({ executorAddress, txHash }, `🛑 Contrato KILLED on-chain confirmado`);

    return { status: 'submitted', txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { executorAddress, err: msg },
      `Falha ao submeter kill() on-chain: ${msg.slice(0, 200)}`,
    );
    return { status: 'failed', reason: msg.slice(0, 200) };
  }
}
