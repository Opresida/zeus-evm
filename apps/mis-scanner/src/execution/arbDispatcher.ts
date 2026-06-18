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
import { gasCostUsd, type GasOracle, type PnlTracker, type FailureTracker } from '@zeus-evm/execution-utils';
import { flashloanAssetOf } from './arbOpportunity';

type AnyPublicClient = PublicClient<any, any>;
type AnyWalletClient = WalletClient<any, any, any>;

export type ArbMode = 'dryrun' | 'testnet' | 'mainnet';

export interface ArbDispatchDeps {
  mode: ArbMode;
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
  // Intelligence opcional (Parte B liga)
  pnlTracker?: PnlTracker;
  failureTracker?: FailureTracker;
  /** Hook pós-dispatch pra reconciliação/post-mortem (Parte B). */
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

  // 5. DRY_RUN: loga e não submete.
  if (mode === 'dryrun') {
    logger.info(
      { pair: opp.pair.id, profitUsd: opp.profitUsd.toFixed(2), flashSource: flashSel.flashSource, gasSim: sim.gasUsed?.toString() },
      `🟦 DRY_RUN arb: ${opp.pair.id} válida (não submetida) profit~$${opp.profitUsd.toFixed(2)}`,
    );
    const result: ArbDispatchResult = { status: 'dryrun_skipped', netProfitUsd: filtered.netProfitUsd, flashSource: flashSel.flashSource };
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

    if (receipt.status === 'reverted') {
      const gasUsd = gasCostUsd(receipt.gasUsed, receipt.effectiveGasPrice ?? 0n, deps.ethUsdPrice);
      deps.pnlTracker?.recordLoss(gasUsd, { txHash, chain: chainConfig.name, reason: 'arb reverted on-chain' });
      deps.failureTracker?.recordFailure(`arb revert ${txHash}`);
      const result: ArbDispatchResult = { status: 'reverted_on_chain', txHash, flashSource: flashSel.flashSource };
      await deps.onResult?.(result, { opp, calldata });
      return result;
    }

    deps.failureTracker?.recordSuccess();
    const result: ArbDispatchResult = { status: 'dispatched', txHash, netProfitUsd: filtered.netProfitUsd, flashSource: flashSel.flashSource };
    await deps.onResult?.(result, { opp, calldata });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ pair: opp.pair.id, err: msg }, `arb dispatch falhou: ${msg.slice(0, 160)}`);
    return { status: 'rejected', reason: msg.slice(0, 160), flashSource: flashSel.flashSource };
  }
}
