/**
 * Dispatcher de arb do Motor 2 — gate → fonte de flashloan → build → simula → dispara.
 *
 * Reusa a infra do strategy (mesmo padrão do backrun): filterOpportunity (gate de EV),
 * selectFlashSource (Morpho/Balancer 0% > Aave), buildFlashloanCalldata, simulateArbitrage.
 * Atomic-only: qualquer falha reverte a TX inteira (flashloan). Dispara só se a simulação passar.
 *
 * Em DRY_RUN: simula e loga, não submete. Em testnet/mainnet: submete via wallet.
 */

import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';
import {
  filterOpportunity,
  buildFlashloanCalldata,
  selectFlashSource,
  simulateArbitrage,
  type CrossDexOpportunity,
} from '@zeus-evm/strategy';
import {
  gasCostUsd,
  realizedPriorityFeeWei,
  decodeLiquidationEvent,
  generateFailureId,
  type GasOracle,
  type PnlTracker,
  type FailureTracker,
  type PnlReconciler,
  type FailureCollector,
  type FailureEvent,
  type EventBus,
  type CompetitorResolver,
  type BlockPositionTracker,
} from '@zeus-evm/execution-utils';
import { flashloanAssetOf } from './arbOpportunity';

type AnyPublicClient = PublicClient<any, any>;
type AnyWalletClient = WalletClient<any, any, any>;

export type ArbMode = 'dryrun' | 'testnet' | 'mainnet';

export interface ArbDispatchDeps {
  mode: ArbMode;
  /**
   * Trava de execução ao vivo (modelo "armado-mas-travado"). Default/ausente = false = TRAVADO:
   * mesmo em modo testnet/mainnet, simula + observa mas NÃO submete tx. Ligado remotamente via
   * Supabase `engine_control` (ver index.ts poll). Fail-safe: na dúvida, fica false.
   */
  liveExecutionEnabled?: boolean;
  client: AnyPublicClient;
  wallet?: AnyWalletClient;
  account?: Address;
  executorAddress?: Address;
  chainConfig: ChainConfig;
  gasOracle: GasOracle;
  profitReceiver: Address;
  ethUsdPrice: number;
  logger: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; debug: (o: unknown, m?: string) => void };
  // Gate (EV)
  minProfitUsd: number;
  maxSlippageBps: number;
  maxTradeWei: bigint;
  estimatedGasUsd: number;
  // Intelligence (Parte B)
  pnlTracker?: PnlTracker;
  failureTracker?: FailureTracker;
  pnlReconciler?: PnlReconciler;
  failureCollector?: FailureCollector;
  eventBus?: EventBus;
  competitorResolver?: CompetitorResolver;
  blockPositionTracker?: BlockPositionTracker;
  /** Hook pós-dispatch (extensibilidade). */
  onResult?: (r: ArbDispatchResult, ctx: { opp: CrossDexOpportunity; calldata: Hex }) => void | Promise<void>;
}

export interface ArbDispatchResult {
  status: 'dispatched' | 'dryrun_skipped' | 'rejected' | 'reverted_on_chain';
  reason?: string;
  txHash?: `0x${string}`;
  netProfitUsd?: number;
  flashSource?: number;
}

/**
 * Dispara (ou simula) uma oportunidade de arb cross-DEX já cotada FRESCO.
 */
export async function dispatchArb(opp: CrossDexOpportunity, deps: ArbDispatchDeps): Promise<ArbDispatchResult> {
  const { mode, client, chainConfig, logger } = deps;

  // 1. Gate de EV (min profit líquido após gás + flashloan fee + cap de trade).
  const filtered = filterOpportunity(opp, {
    minProfitUsd: deps.minProfitUsd,
    maxSlippageBps: deps.maxSlippageBps,
    maxTradeWei: deps.maxTradeWei,
    estimatedGasUsd: deps.estimatedGasUsd,
    flashloanFeeBps: 5, // conservador (Aave 0,05%); fonte 0% é bônus capturado on-chain
  });
  if (!filtered.passed) {
    return { status: 'rejected', reason: filtered.reason };
  }

  const flashloanAsset = flashloanAssetOf(opp);
  const flashloanAmount = opp.amountIn;

  // 2. Fonte de flashloan mais barata (Morpho/Balancer 0% > Aave) — fail-safe Aave.
  const flashSel = await selectFlashSource(client, chainConfig, flashloanAsset, flashloanAmount);

  // 3. Calldata.
  const calldata = buildFlashloanCalldata({
    opp,
    profitReceiver: deps.profitReceiver,
    slippageBps: deps.maxSlippageBps,
    flashloanAsset,
    flashloanAmount,
    flashSource: flashSel.flashSource,
  });

  if (!deps.executorAddress) {
    return { status: 'rejected', reason: 'executor address ausente', flashSource: flashSel.flashSource };
  }

  // 4. Simula on-chain (eth_call) — atomic-only: só dispara se passar.
  const sim = await simulateArbitrage({
    client,
    executorAddress: deps.executorAddress,
    callerAddress: deps.account ?? deps.profitReceiver,
    calldata,
    blockNumber: opp.blockNumber,
  });
  if (!sim.success) {
    return { status: 'rejected', reason: `simulação reverteu: ${sim.revertReason ?? 'unknown'}`, flashSource: flashSel.flashSource };
  }

  // 5. DRY_RUN ou execução TRAVADA (armado-mas-travado): simula, observa e NÃO submete.
  //    A simulação já rodou (passo 4) → o ledger ganha o dado rico mesmo com o envio travado.
  if (mode === 'dryrun' || !deps.liveExecutionEnabled) {
    const locked = mode !== 'dryrun'; // modo live mas toggle remoto OFF
    logger.info(
      { pair: opp.pair.id, profitUsd: opp.profitUsd.toFixed(2), flashSource: flashSel.flashSource, gasSim: sim.gasUsed?.toString(), locked },
      locked
        ? `🔒 arb TRAVADO (toggle OFF): ${opp.pair.id} válida+simulada, envio bloqueado — profit~$${opp.profitUsd.toFixed(2)}`
        : `🟦 DRY_RUN arb: ${opp.pair.id} válida (não submetida) profit~$${opp.profitUsd.toFixed(2)}`,
    );
    const result: ArbDispatchResult = { status: 'dryrun_skipped', reason: locked ? 'execution_locked' : undefined, netProfitUsd: filtered.netProfitUsd, flashSource: flashSel.flashSource };
    await deps.onResult?.(result, { opp, calldata });
    return result;
  }

  // 6. Live: exige wallet.
  if (!deps.wallet || !deps.account) {
    return { status: 'rejected', reason: 'wallet ausente em modo não-dryrun', flashSource: flashSel.flashSource };
  }

  try {
    const fees = await deps.gasOracle.getFees(client);
    const txParams: Record<string, unknown> = {
      account: deps.account,
      to: deps.executorAddress,
      data: calldata,
      chain: deps.wallet.chain ?? null,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
    logger.info({ pair: opp.pair.id, mode }, `🚀 arb SUBMETENDO (${mode}) — ${opp.pair.id}`);
    const txHash = await deps.wallet.sendTransaction(txParams as any);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });

    const gasUsd = gasCostUsd(receipt.gasUsed, receipt.effectiveGasPrice ?? 0n, deps.ethUsdPrice);

    if (receipt.status === 'reverted') {
      deps.pnlTracker?.recordLoss(gasUsd, { txHash, chain: chainConfig.name, reason: 'arb reverted on-chain' });
      deps.failureTracker?.recordFailure(`arb revert ${txHash}`);
      // Falha rica + post-mortem (quem nos ganhou + posição no bloco) — espelha liquidator/backrun.
      if (deps.failureCollector) {
        const fe: FailureEvent = {
          id: generateFailureId(Date.now()), timestamp: Date.now(), chain: chainConfig.name, mode,
          protocol: 'arb', category: 'reverted_on_chain', category_confidence: 0.95,
          our_tx_hash: txHash, our_gas_used: receipt.gasUsed.toString(), our_gas_usd_lost: gasUsd,
          our_tx_index: receipt.transactionIndex, block_number: receipt.blockNumber.toString(),
          opportunity_id: opp.pair.id, expected_profit_usd: opp.profitUsd,
          payload: { buyVenue: opp.buyQuote.source, sellVenue: opp.sellQuote.source },
        };
        try {
          if (deps.blockPositionTracker) {
            const pos = await deps.blockPositionTracker.resolve(txHash, receipt.blockNumber);
            if (pos) { fe.block_total_txs = pos.block_total_txs; (fe.payload as Record<string, unknown>).is_bottom_10pct = pos.is_bottom_10pct; }
          }
          if (deps.competitorResolver && deps.account) {
            const w = await deps.competitorResolver.resolve(fe, deps.account);
            if (w) { fe.competitor_winner_sender = w.winner_sender; fe.competitor_winner_alias = w.winner_alias; fe.competitor_winner_priority_fee_wei = w.winner_priority_fee_wei?.toString(); }
          }
        } catch { /* post-mortem nunca quebra o fluxo */ }
        deps.failureCollector.record(fe);
        deps.eventBus?.emit({ type: 'failure.recorded', timestamp: new Date().toISOString(), chain: chainConfig.name, mode, severity: 'warn', protocol: 'arb', failureCategory: 'reverted_on_chain', txHash, gasUsdLost: gasUsd, reason: 'arb reverted on-chain' });
      }
      const result: ArbDispatchResult = { status: 'reverted_on_chain', txHash, flashSource: flashSel.flashSource };
      await deps.onResult?.(result, { opp, calldata });
      return result;
    }

    deps.failureTracker?.recordSuccess();

    // Reconciliação (esperado vs realizado) — alimenta PnlAggregator + DriftTracker via onReconcile.
    if (deps.pnlReconciler) {
      try {
        const decoded = deps.executorAddress ? decodeLiquidationEvent(receipt, deps.executorAddress) : null;
        const realizedProfitWei = decoded?.profitWei ?? 0n;
        const realizedProfitUsd = (Number(realizedProfitWei) / Math.pow(10, opp.pair.decimalsA)) * opp.pair.estimatedUsdValueA;
        const block = await client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);
        const recon = deps.pnlReconciler.reconcile({
          chain: chainConfig.name, protocol: 'arb', tx_hash: txHash, block_number: receipt.blockNumber,
          expected_profit_wei: opp.profitWei, expected_profit_usd: opp.profitUsd,
          realized_profit_wei: realizedProfitWei, realized_profit_usd: realizedProfitUsd,
          realized_gas_units_used: receipt.gasUsed, realized_gas_usd: gasUsd,
          realized_priority_fee_wei: realizedPriorityFeeWei(receipt.effectiveGasPrice, block?.baseFeePerGas),
          eth_usd_price: deps.ethUsdPrice, opportunity_id: opp.pair.id, venue: opp.buyQuote.source, finality_status: 'soft',
        });
        deps.eventBus?.emit({ type: 'pnl.reconciled', timestamp: new Date().toISOString(), chain: chainConfig.name, mode, severity: 'info', protocol: 'arb', txHash, blockNumber: receipt.blockNumber.toString(), expectedNetUsd: recon.expected.net_profit_usd_estimated, realizedNetUsd: recon.realized.net_profit_usd, profitDeltaBps: recon.deltas.profit_delta_bps, gasUsd: recon.realized.gas_usd_actual, attributionCause: recon.attribution.primary_cause });
      } catch (err) {
        deps.logger.warn({ txHash, err: err instanceof Error ? err.message : err }, 'reconciliação de arb falhou (segue)');
      }
    }

    const result: ArbDispatchResult = { status: 'dispatched', txHash, netProfitUsd: filtered.netProfitUsd, flashSource: flashSel.flashSource };
    await deps.onResult?.(result, { opp, calldata });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ pair: opp.pair.id, err: msg }, `arb dispatch falhou: ${msg.slice(0, 160)}`);
    return { status: 'rejected', reason: msg.slice(0, 160), flashSource: flashSel.flashSource };
  }
}
