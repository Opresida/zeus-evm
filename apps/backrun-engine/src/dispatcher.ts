/**
 * Backrun dispatcher — análogo ao dispatcher do liquidator, mas pra backrun.
 *
 * Modos:
 *   - dryrun: NÃO submete, registra "iria submeter" no log + evento
 *   - testnet: submete em Sepolia
 *   - mainnet: submete em mainnet
 *
 * EIP-1559 gas pricing via GasOracle (cache por bloco).
 *
 * Difere do liquidator em alguns pontos:
 *   - Sem dedup tracker (cada whale tx é único, não tem race)
 *   - Sem stale check (oportunidade decai em 1 bloco, validamos via simulação)
 *   - Profit decoded direto do evento ArbitrageExecuted ou FlashloanArbitrageExecuted
 */

import type { Address, Hex } from 'viem';

import type {
  EventBus,
  PnlTracker,
  FailureTracker,
  GasOracle,
  BackrunDispatchedEvent,
} from '@zeus-evm/execution-utils';
import {
  decodeLiquidationEvent,
  estimateUsd,
  gasCostUsd,
} from '@zeus-evm/execution-utils';
import type { BackrunOpportunity } from '@zeus-evm/strategy';

import type { BackrunEnv, BackrunMode } from './config';
import type { BackrunChainContext } from './chainContext';
import { logger } from './logger';

export interface DispatchBackrunInput {
  mode: BackrunMode;
  chainCtx: BackrunChainContext;
  env: BackrunEnv;
  eventBus: EventBus;
  pnlTracker: PnlTracker;
  failureTracker: FailureTracker;
  gasOracle: GasOracle;
  opp: BackrunOpportunity;
  flashloanAsset: Address;
  flashloanAmount: bigint;
  calldata: Hex;
  netProfitUsd: number;
  simulationGas?: bigint;
}

export interface DispatchBackrunResult {
  status: 'dispatched' | 'dryrun_skipped' | 'rejected';
  reason?: string;
  txHash?: `0x${string}`;
}

export async function dispatchBackrun(
  input: DispatchBackrunInput,
): Promise<DispatchBackrunResult> {
  const {
    mode,
    chainCtx,
    env,
    eventBus,
    pnlTracker,
    failureTracker,
    gasOracle,
    opp,
    flashloanAmount,
    calldata,
    netProfitUsd,
    simulationGas,
  } = input;

  const nowIso = () => new Date().toISOString();

  // DRY_RUN: log + evento, sem submeter
  if (mode === 'dryrun') {
    const event: BackrunDispatchedEvent = {
      type: 'backrun.dispatched',
      timestamp: nowIso(),
      chain: chainCtx.chainName,
      mode,
      severity: 'info',
      pendingTxHash: opp.whale.pendingTxHash,
      pairId: opp.pair.id,
      flashloanAmountWei: flashloanAmount.toString(),
      expectedProfitUsd: opp.profitUsd,
      ourTxHash: null,
    };
    eventBus.emit(event);

    logger.info(
      {
        pairId: opp.pair.id,
        flashloanAmountWei: flashloanAmount.toString(),
        expectedProfitUsd: opp.profitUsd.toFixed(4),
        netProfitUsd: netProfitUsd.toFixed(4),
        simGas: simulationGas?.toString(),
      },
      `🟦 DRY_RUN backrun: tx VÁLIDA (não submetida) net=$${netProfitUsd.toFixed(2)}`,
    );
    return { status: 'dryrun_skipped', reason: 'mode=dryrun' };
  }

  // Testnet/mainnet exigem wallet
  if (!chainCtx.wallet || !chainCtx.account) {
    logger.error({ mode }, 'Wallet ausente em modo testnet/mainnet — abortando backrun');
    return { status: 'rejected', reason: 'wallet missing in non-dryrun mode' };
  }
  if (!chainCtx.executorAddress) {
    return { status: 'rejected', reason: 'executor address ausente' };
  }

  try {
    const fees = await gasOracle.getFees(chainCtx.client);

    const txParams: Record<string, unknown> = {
      account: chainCtx.account,
      to: chainCtx.executorAddress,
      data: calldata,
      chain: chainCtx.wallet.chain ?? null,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };

    logger.info(
      {
        pairId: opp.pair.id,
        netProfitUsd: netProfitUsd.toFixed(4),
        maxFeeGwei: (Number(fees.maxFeePerGas) / 1e9).toFixed(4),
        priorityGwei: (Number(fees.maxPriorityFeePerGas) / 1e9).toFixed(4),
      },
      `🚀 Backrun SUBMETENDO (${mode}) — ${opp.pair.id} net=$${netProfitUsd.toFixed(2)}`,
    );

    const txHash = await chainCtx.wallet.sendTransaction(txParams as any);
    logger.info({ txHash, pair: opp.pair.id }, `📤 Backrun submetido: ${txHash}`);

    const receipt = await chainCtx.client.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
    });

    const gasUsdSpent = gasCostUsd(
      receipt.gasUsed,
      receipt.effectiveGasPrice ?? 0n,
      env.ETH_USD_PRICE_ESTIMATE,
    );

    if (receipt.status === 'reverted') {
      pnlTracker.recordLoss(gasUsdSpent, {
        txHash,
        chain: chainCtx.chainName,
        protocol: 'backrun',
        reason: `backrun reverted on-chain at block ${receipt.blockNumber}`,
      });
      failureTracker.recordFailure(`backrun revert ${txHash}`);
      logger.error(
        { txHash, gasUsdLost: gasUsdSpent.toFixed(4) },
        `💥 Backrun REVERTIDO — gas perdido $${gasUsdSpent.toFixed(4)}`,
      );
      return { status: 'rejected', reason: 'reverted on-chain', txHash };
    }

    // Decoda profit real do evento ArbitrageExecuted ou FlashloanArbitrageExecuted
    const decoded = decodeLiquidationEvent(receipt, chainCtx.executorAddress);
    const profitWei = decoded?.profitWei ?? 0n;
    const profitTokenSymbol = guessProfitSymbol(opp);
    const profitUsd = estimateUsd(
      profitTokenSymbol,
      profitWei,
      opp.whale.tokenInDecimals,
      env.ETH_USD_PRICE_ESTIMATE,
    );
    const netUsd = profitUsd !== undefined ? profitUsd - gasUsdSpent : null;

    if (netUsd !== null && netUsd > 0) {
      pnlTracker.recordWin(netUsd, {
        txHash,
        chain: chainCtx.chainName,
        protocol: 'backrun',
      });
      failureTracker.recordSuccess();
    } else if (netUsd !== null && netUsd < 0) {
      pnlTracker.recordLoss(Math.abs(netUsd), {
        txHash,
        chain: chainCtx.chainName,
        protocol: 'backrun',
        reason: `confirmed mas net negativo (profit=$${(profitUsd ?? 0).toFixed(2)}, gas=$${gasUsdSpent.toFixed(2)})`,
      });
      failureTracker.recordFailure(`net negative ${txHash}`);
    } else {
      failureTracker.recordSuccess();
    }

    const event: BackrunDispatchedEvent = {
      type: 'backrun.dispatched',
      timestamp: nowIso(),
      chain: chainCtx.chainName,
      mode,
      severity: 'info',
      pendingTxHash: opp.whale.pendingTxHash,
      pairId: opp.pair.id,
      flashloanAmountWei: flashloanAmount.toString(),
      expectedProfitUsd: opp.profitUsd,
      ourTxHash: txHash,
    };
    eventBus.emit(event);

    logger.info(
      {
        txHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        gasUsdSpent: gasUsdSpent.toFixed(4),
        profitUsd: profitUsd?.toFixed(4) ?? 'n/a',
        netUsd: netUsd?.toFixed(4) ?? 'n/a',
      },
      `✅ Backrun CONFIRMADO ${txHash} — net $${netUsd?.toFixed(2) ?? 'n/a'}`,
    );
    return { status: 'dispatched', txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, `💥 Backrun dispatch falhou: ${msg.slice(0, 200)}`);
    failureTracker.recordFailure(`dispatch error: ${msg.slice(0, 100)}`);
    return { status: 'rejected', reason: msg.slice(0, 200) };
  }
}

/**
 * Heurística simples pra mapear o cycle token do backrun → symbol pra `estimateUsd`.
 * Pra MVP, identifica USDC/USDbC/DAI/USDT/WETH/AERO comparando addresses do TargetPair.
 */
function guessProfitSymbol(opp: BackrunOpportunity): string {
  const profitToken = opp.whale.tokenIn.toLowerCase();
  if (opp.pair.tokenA.toLowerCase() === profitToken) {
    // tokenA == cycle token; symbol vem do id ex "AERO/USDC" → tokenA é "AERO"
    return opp.pair.id.split('/')[0] ?? 'UNKNOWN';
  }
  return opp.pair.id.split('/')[1] ?? 'UNKNOWN';
}
