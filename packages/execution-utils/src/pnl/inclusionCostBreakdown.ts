/**
 * InclusionCostBreakdown — Item 10 P4 do checklist.
 *
 * Decomposição limpa do "custo total pra incluir 1 tx" em componentes:
 *  - base_fee (EIP-1559 burned — não vai pra ninguém)
 *  - priority_fee (vai pro proposer/builder)
 *  - l1_data_fee (Base/Optimism — custo de DA na L1, capturado no receipt)
 *  - bribe (BribePaid event ou coinbase.transfer)
 *
 * Por que standalone:
 *  - PnlReconciler já calcula inline, mas só pós-confirmação
 *  - Backrun engine precisa estimar pré-dispatch (what-if)
 *  - Bid calibrator precisa decompor pra decidir onde cortar
 *
 * Stateless. Recebe wei + ETH price → retorna USD por bucket.
 */

export interface InclusionCostInput {
  /** Gas units used (do receipt). */
  gasUnitsUsed: bigint;
  /** Base fee per gas (do bloco onde minou). */
  baseFeePerGas: bigint;
  /** Priority fee per gas (effectiveGasPrice - baseFee). */
  priorityFeePerGas: bigint;
  /** L1 data fee (Base/OP only — receipt.l1Fee). 0 em mainnet pura. */
  l1FeeWei?: bigint;
  /** Bribe pago via BribePaid event ou coinbase.transfer. */
  bribeWei?: bigint;
  /** ETH price em USD pra conversão. */
  ethUsdPrice: number;
  /** Profit bruto realized (pra calcular % of profit). 0 se não disponível. */
  realizedProfitUsd?: number;
}

export interface InclusionCostBreakdown {
  base_fee_wei: bigint;
  base_fee_usd: number;          // queimado — não vai pra ninguém
  priority_fee_wei: bigint;
  priority_fee_usd: number;      // proposer/builder
  l1_data_fee_wei: bigint;
  l1_data_fee_usd: number;       // L2 only (DA cost)
  bribe_wei: bigint;
  bribe_usd: number;             // coinbase / builder
  total_inclusion_usd: number;   // priority + l1 + bribe (NÃO inclui base, já que é queimado)
  total_cost_usd: number;        // priority + l1 + bribe + base (custo bruto)
  inclusion_as_percent_of_profit: number; // 0-1
  /** Component que dominou o custo (priority_fee | l1_data_fee | bribe | base_fee). */
  dominant_component: 'base_fee' | 'priority_fee' | 'l1_data_fee' | 'bribe';
}

/**
 * Converte wei pra USD: (wei / 1e18) * ethUsdPrice.
 * Usa Number só após dividir por 1e9 pra preservar precisão em valores grandes.
 */
function weiToUsd(wei: bigint, ethUsdPrice: number): number {
  if (wei === 0n) return 0;
  // wei é até ~1e18 em txs normais — Number sustenta isso até ~9e15 sem perder precisão
  // Dividir antes em 2 passos pra evitar overflow em casos extremos
  const gwei = Number(wei / 1_000_000_000n) + Number(wei % 1_000_000_000n) / 1e9;
  return (gwei / 1e9) * ethUsdPrice;
}

/**
 * Decompõe custo total de inclusão em componentes.
 *
 * @example
 *   const breakdown = computeInclusionCost({
 *     gasUnitsUsed: 350_000n,
 *     baseFeePerGas: 50_000_000n,        // 0.05 gwei (Base)
 *     priorityFeePerGas: 100_000_000n,   // 0.1 gwei tip
 *     l1FeeWei: 12_000_000_000_000n,     // ~$0.04 em ETH a $3500
 *     bribeWei: 500_000_000_000_000n,    // 0.0005 ETH = ~$1.75 bribe
 *     ethUsdPrice: 3500,
 *     realizedProfitUsd: 25,
 *   });
 *   // breakdown.dominant_component === 'bribe'
 *   // breakdown.inclusion_as_percent_of_profit === ~0.07
 */
export function computeInclusionCost(input: InclusionCostInput): InclusionCostBreakdown {
  const baseFeeWei = input.baseFeePerGas * input.gasUnitsUsed;
  const priorityFeeWei = input.priorityFeePerGas * input.gasUnitsUsed;
  const l1FeeWei = input.l1FeeWei ?? 0n;
  const bribeWei = input.bribeWei ?? 0n;

  const baseFeeUsd = weiToUsd(baseFeeWei, input.ethUsdPrice);
  const priorityFeeUsd = weiToUsd(priorityFeeWei, input.ethUsdPrice);
  const l1FeeUsd = weiToUsd(l1FeeWei, input.ethUsdPrice);
  const bribeUsd = weiToUsd(bribeWei, input.ethUsdPrice);

  // Inclusion = o que efetivamente foi pago pra "ganhar slot" (não inclui base burn)
  const totalInclusionUsd = priorityFeeUsd + l1FeeUsd + bribeUsd;
  const totalCostUsd = totalInclusionUsd + baseFeeUsd;

  const inclusionAsPercentOfProfit = (input.realizedProfitUsd ?? 0) > 0
    ? totalInclusionUsd / (input.realizedProfitUsd ?? 1)
    : 0;

  // Identifica componente dominante
  const components: Array<[InclusionCostBreakdown['dominant_component'], number]> = [
    ['base_fee', baseFeeUsd],
    ['priority_fee', priorityFeeUsd],
    ['l1_data_fee', l1FeeUsd],
    ['bribe', bribeUsd],
  ];
  components.sort((a, b) => b[1] - a[1]);
  const dominant_component = components[0]![0];

  return {
    base_fee_wei: baseFeeWei,
    base_fee_usd: baseFeeUsd,
    priority_fee_wei: priorityFeeWei,
    priority_fee_usd: priorityFeeUsd,
    l1_data_fee_wei: l1FeeWei,
    l1_data_fee_usd: l1FeeUsd,
    bribe_wei: bribeWei,
    bribe_usd: floorNoise(bribeUsd),
    total_inclusion_usd: totalInclusionUsd,
    total_cost_usd: totalCostUsd,
    inclusion_as_percent_of_profit: inclusionAsPercentOfProfit,
    dominant_component,
  };
}

/** Floor tiny float noise to 0 (anything under 1 wei equivalent). */
function floorNoise(v: number): number {
  return v < 1e-12 ? 0 : v;
}

/**
 * Formata breakdown como linha humana pra log.
 */
export function formatBreakdownLog(b: InclusionCostBreakdown): string {
  return (
    `[inclusion] base=$${b.base_fee_usd.toFixed(4)} ` +
    `prio=$${b.priority_fee_usd.toFixed(4)} ` +
    `l1=$${b.l1_data_fee_usd.toFixed(4)} ` +
    `bribe=$${b.bribe_usd.toFixed(4)} ` +
    `total=$${b.total_inclusion_usd.toFixed(4)} ` +
    `dom=${b.dominant_component}` +
    (b.inclusion_as_percent_of_profit > 0
      ? ` pct_of_profit=${(b.inclusion_as_percent_of_profit * 100).toFixed(1)}%`
      : '')
  );
}
