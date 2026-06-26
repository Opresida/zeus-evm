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
import {
  decodeLiquidationEvent,
  profitDeltaBps,
  estimateUsd,
  formatWei,
  gasCostUsd,
  decodeLastSwap,
  decodeBribeEvent,
  realizedPriorityFeeWei,
  type PnlTracker,
  type PnlEvent,
  type FailureTracker,
  type PositionDedupTracker,
  type EventBus,
  type GasOracle,
  type PnlReconciler,
  type FailureCollector,
  type FailureEvent,
  type CompetitorResolver,
  type BlockPositionTracker,
  type MetricRegistry,
} from '@zeus-evm/execution-utils';
import { generateFailureId } from '@zeus-evm/execution-utils';
import type { LiquidatorMode as MMode } from './config';

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
  /**
   * Toggle remoto de execução (painel → Supabase engine_control). Modelo armado-mas-travado:
   *   - `undefined` → controle remoto INATIVO (preserva comportamento: envia conforme o mode).
   *   - `true`      → liberado pelo painel (envia).
   *   - `false`     → TRAVADO pelo painel (não submete; loga como held). Fail-safe default.
   * Os circuit breakers do contrato (MAX_TRADE, minProfit, sim+EV gate) seguem valendo por cima.
   */
  liveExecutionEnabled?: boolean;
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
  /** Dedup tracker pra evitar re-submeter mesma position em ticks consecutivos. */
  dedupTracker?: PositionDedupTracker;
  /** Chave única da position pra dedup (ex: "base:aave-v3:0xabc..."). */
  positionKey?: string;
  /** Protocolo da operação — pra registrar no PnL event.
   *  Restrito a protocolos de liquidação (sem 'backrun' que é outro app). */
  protocol?: 'aave-v3' | 'compound-v3' | 'morpho-blue' | 'moonwell' | 'morpho-preliq';
  /** Event bus pra emitir eventos tipados (webhook/WebSocket futuro). */
  eventBus?: EventBus;
  /** Borrower address (pra emitir nos eventos de tx). */
  borrower?: Address;
  /** Chain ativa pra contexto dos eventos. */
  chain?: string;
  /** Gas oracle EIP-1559 — fornece maxFee/maxPriority corretos por bloco. */
  gasOracle?: GasOracle;
  /** PnL reconciler — gera análise expected vs realized rica + attribution. */
  pnlReconciler?: PnlReconciler;
  /** Failure collector — persiste failures com schema rico em JSONL. */
  failureCollector?: FailureCollector;
  /** Expected gas USD do calculator (pra reconciliation drift). */
  expectedGasUsd?: number;
  /** Expected swap output do calculator (pra slippage real cálculo). */
  expectedSwapOutputWei?: bigint;
  /** Opportunity id (borrower address) pra cross-ref no schema. */
  opportunityId?: string;
  /** Venue/market label (ex: 'seamless') pra distinguir forks Aave no reconciler. */
  venue?: string;
  /** MetricRegistry opcional — pra cronometrar dispatch (histograma zeus_dispatch_duration_seconds). */
  metricRegistry?: MetricRegistry;
  /** Fase 5b — post-mortem: descobre QUEM nos ganhou numa falha (só com tx real). */
  competitorResolver?: CompetitorResolver;
  /** Fase 5b — post-mortem: posição da nossa tx no bloco (perdemos corrida/sandwich?). */
  blockPositionTracker?: BlockPositionTracker;
  /** Endereço do nosso bot (pra o resolver ignorar nossas próprias txs). */
  botSender?: Address;
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
    liveExecutionEnabled,
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
    dedupTracker,
    positionKey,
    protocol,
    eventBus,
    borrower,
    chain,
    gasOracle,
    metricRegistry,
  } = input;

  const chainName = chain ?? (typeof summary.chain === 'string' ? summary.chain : 'unknown');
  const nowIso = () => new Date().toISOString();

  // Gate 1: simulação tem que ter passado
  if (!simulationOk) {
    logger.warn(
      { ...summary, simulationReason },
      `❌ Dispatch ABORTADO — simulation falhou: ${simulationReason}`,
    );
    if (eventBus && protocol && borrower) {
      eventBus.emit({
        type: 'tx.reverted_pre_dispatch',
        timestamp: nowIso(),
        chain: chainName,
        mode,
        severity: 'info',
        protocol,
        borrower,
        reason: simulationReason ?? 'simulation failed',
      });
    }
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

  // Gate 2.5: toggle remoto (painel). ARMADO-MAS-TRAVADO — em testnet/mainnet, se o painel
  // não liberou (liveExecutionEnabled === false), a tx é VÁLIDA mas NÃO submetida. Fail-safe:
  // só `false` explícito trava; `undefined` = controle remoto inativo (preserva comportamento).
  if (liveExecutionEnabled === false) {
    logger.info(
      { ...summary, gasEstimate: simulationGas?.toString() },
      `🔒 ARMADO-MAS-TRAVADO: tx VÁLIDA, envio TRAVADO pelo painel (toggle remoto OFF). Gas est.: ${simulationGas?.toString() ?? 'n/a'}`,
    );
    return { status: 'dryrun_skipped', reason: 'execução travada pelo painel (engine_control OFF)' };
  }

  // Gate 3: wallet obrigatória em testnet/mainnet
  if (!wallet || !account) {
    logger.error({ ...summary }, 'Wallet ausente em modo testnet/mainnet — abortando');
    return { status: 'reverted_pre_dispatch', reason: 'wallet missing in non-dryrun mode' };
  }

  // Submete com EIP-1559 fees (Base/Arb/OP usam EIP-1559)
  try {
    // Busca fees do oracle (cacheado por bloco). Se oracle ausente, viem usa default.
    const fees = gasOracle ? await gasOracle.getFees(client) : null;

    const txParams: Record<string, unknown> = {
      account,
      to,
      data,
      chain: wallet.chain ?? null,
    };
    if (fees) {
      txParams.maxFeePerGas = fees.maxFeePerGas;
      txParams.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      logger.debug(
        {
          maxFeeGwei: (Number(fees.maxFeePerGas) / 1e9).toFixed(4),
          priorityGwei: (Number(fees.maxPriorityFeePerGas) / 1e9).toFixed(4),
          baseFeeGwei: (Number(fees.baseFeePerGas) / 1e9).toFixed(4),
        },
        `⛽ EIP-1559 fees aplicados`,
      );
    }

    logger.info({ ...summary, mode }, `🚀 SUBMETENDO tx (${mode})...`);
    const dispatchStart = Date.now(); // Fase 7b — cronômetro do dispatch (submit→confirm)
    const txHash = await wallet.sendTransaction(txParams as any);

    logger.info({ ...summary, txHash, mode }, `📤 Tx submetida: ${txHash}`);

    // Dedup: marca position como pending durante await
    if (dedupTracker && positionKey) {
      dedupTracker.markPending(positionKey, txHash);
    }

    // Aguarda confirmação
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
    // Histograma de latência dispatch (antes morto) — segundos do submit até 1 conf.
    metricRegistry?.observe('zeus_dispatch_duration_seconds', (Date.now() - dispatchStart) / 1000, {
      chain: chainName,
      protocol: protocol ?? 'unknown',
    });

    if (receipt.status === 'reverted') {
      // Gas perdido em tx revertida = LOSS pra PnL tracker (em USD)
      const revertGasUsd = gasCostUsd(receipt.gasUsed, receipt.effectiveGasPrice ?? 0n, ethUsdPrice);
      pnlTracker?.recordLoss(revertGasUsd, {
        txHash,
        chain: chainName,
        protocol,
        reason: `reverted on-chain at block ${receipt.blockNumber}`,
      });

      // FailureCollector: schema rico pra análise post-mortem
      if (input.failureCollector && protocol) {
        const failureEvent: FailureEvent = {
          id: generateFailureId(Date.now()),
          timestamp: Date.now(),
          chain: chainName ?? 'Base',
          mode,
          protocol,
          category: 'reverted_on_chain',
          category_confidence: 0.95,
          our_tx_hash: txHash,
          our_gas_used: receipt.gasUsed.toString(),
          our_gas_usd_lost: revertGasUsd,
          our_tx_index: receipt.transactionIndex,
          block_number: receipt.blockNumber.toString(),
          opportunity_id: input.opportunityId,
          expected_profit_usd: input.expectedProfitWei > 0n
            ? estimateUsd(profitAssetSymbol, input.expectedProfitWei, profitAssetDecimals, ethUsdPrice)
            : undefined,
          payload: { revert_reason: 'on-chain revert', block_hash: receipt.blockHash },
        };

        // Fase 5b — enriquecimento post-mortem (só roda com tx real, dormente em DRY_RUN):
        //  - posição no bloco (perdemos corrida? sandwich?) + total de txs
        //  - QUEM nos ganhou (sender + gás), pro digest de falhas + calibração de bribe
        try {
          if (input.blockPositionTracker) {
            const pos = await input.blockPositionTracker.resolve(txHash, receipt.blockNumber);
            if (pos) {
              failureEvent.block_total_txs = pos.block_total_txs;
              (failureEvent.payload as Record<string, unknown>).relative_position = pos.relative_position;
              (failureEvent.payload as Record<string, unknown>).is_bottom_10pct = pos.is_bottom_10pct;
            }
          }
          if (input.competitorResolver && input.botSender) {
            const winner = await input.competitorResolver.resolve(failureEvent, input.botSender);
            if (winner) {
              failureEvent.competitor_winner_sender = winner.winner_sender;
              failureEvent.competitor_winner_alias = winner.winner_alias;
              failureEvent.competitor_winner_priority_fee_wei = winner.winner_priority_fee_wei?.toString();
            }
          }
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err, txHash }, 'enriquecimento post-mortem falhou (segue)');
        }

        input.failureCollector.record(failureEvent);
        // Fase 4 — leva a falha pro ledger central + counter (via EventBus).
        eventBus?.emit({
          type: 'failure.recorded',
          timestamp: nowIso(),
          chain: chainName ?? 'Base',
          mode,
          severity: 'warn',
          protocol,
          failureCategory: 'reverted_on_chain',
          txHash,
          gasUsdLost: revertGasUsd,
          reason: 'on-chain revert',
        });
      }

      // Contagem de falha consecutiva — cooldown automático após N falhas
      failureTracker?.recordFailure(`reverted on-chain ${txHash}`);
      // Dedup: marca como failed (bloqueia retry por TTL)
      if (dedupTracker && positionKey) {
        dedupTracker.markFailed(positionKey, `reverted on-chain`, txHash);
      }
      // Event bus: notifica external sinks
      if (eventBus && protocol && borrower) {
        eventBus.emit({
          type: 'tx.reverted_on_chain',
          timestamp: nowIso(),
          chain: chainName,
          mode,
          severity: 'warn',
          txHash,
          protocol,
          borrower,
          gasUsdLost: revertGasUsd,
          blockNumber: receipt.blockNumber.toString(),
        });
      }
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

    // Dedup: marca como confirmed (bloqueia retry da mesma position por TTL curto)
    if (dedupTracker && positionKey) {
      dedupTracker.markConfirmed(positionKey, txHash);
    }

    // PnL Reconciliation — schema rico expected vs realized + attribution
    if (input.pnlReconciler && protocol) {
      try {
        const decodedSwap = decodeLastSwap(receipt.logs);
        const decodedBribe = decodeBribeEvent(receipt.logs);
        const realBribeUsd = decodedBribe
          ? (Number(decodedBribe.bribe_native_wei) / 1e18) * ethUsdPrice
          : undefined;
        // Priority fee REAL = effectiveGasPrice − baseFee do bloco (não o gas price cheio).
        const reconBlock = await client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);

        const recon = input.pnlReconciler.reconcile({
          chain: chainName ?? 'Base',
          protocol,
          tx_hash: txHash,
          block_number: receipt.blockNumber,
          expected_profit_wei: input.expectedProfitWei,
          expected_profit_usd: input.expectedProfitWei > 0n
            ? estimateUsd(profitAssetSymbol, input.expectedProfitWei, profitAssetDecimals, ethUsdPrice) ?? 0
            : 0,
          expected_swap_output_wei: input.expectedSwapOutputWei,
          expected_gas_usd: input.expectedGasUsd,
          realized_profit_wei: realProfit,
          realized_profit_usd: profitUsd ?? 0,
          realized_gas_units_used: receipt.gasUsed,
          realized_gas_usd: gasUsdCost,
          realized_priority_fee_wei: realizedPriorityFeeWei(receipt.effectiveGasPrice, reconBlock?.baseFeePerGas),
          realized_swap_output_wei: decodedSwap?.amount_out,
          realized_bribe_wei_paid: decodedBribe?.bribe_native_wei,
          realized_bribe_usd_paid: realBribeUsd,
          eth_usd_price: ethUsdPrice,
          opportunity_id: input.opportunityId,
          venue: input.venue,
          finality_status: 'soft', // 1 conf — pode promover pra 'finalized' depois via FinalityTracker
        });

        // Fase 3 — joga a reconciliação no ledger central via EventBus (EventIngester mapeia).
        if (eventBus) {
          eventBus.emit({
            type: 'pnl.reconciled',
            timestamp: nowIso(),
            chain: chainName ?? 'Base',
            mode,
            severity: 'info',
            protocol,
            txHash,
            blockNumber: receipt.blockNumber.toString(),
            expectedNetUsd: recon.expected.net_profit_usd_estimated,
            realizedNetUsd: recon.realized.net_profit_usd,
            profitDeltaBps: recon.deltas.profit_delta_bps,
            gasUsd: recon.realized.gas_usd_actual,
            attributionCause: recon.attribution.primary_cause,
          });
        }
      } catch (err) {
        // Reconciliation não pode derrubar o bot
        logger.warn(
          { err: err instanceof Error ? err.message : err, txHash },
          'PnlReconciler: erro reconciliando (drop silencioso)',
        );
      }
    }

    // Event bus: emite evento de confirmação pra alertas externos
    if (eventBus && protocol && borrower) {
      eventBus.emit({
        type: 'tx.confirmed',
        timestamp: nowIso(),
        chain: chainName,
        mode,
        severity: 'info',
        txHash,
        protocol,
        borrower,
        profitUsd: profitUsd ?? null,
        gasCostUsd: gasUsdCost,
        netProfitUsd: netProfitUsd ?? null,
        profitDeltaBps: deltaBps,
        blockNumber: receipt.blockNumber.toString(),
      });
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
