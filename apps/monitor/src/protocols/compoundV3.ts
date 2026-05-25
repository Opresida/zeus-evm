/**
 * Compound III (Comet) — discovery de borrowers ativos pra liquidation.
 *
 * Estratégia: NÃO usa subgraph (Compound não tem subgraph oficial bem mantido).
 * Em vez disso:
 *   1. Scan eventos `Withdraw(address,address,uint256)` do Comet nos últimos N blocos
 *      → captura todo borrower que mexeu na position recentemente (proxy de "ativo")
 *   2. Para cada borrower único, chama `isLiquidatable(account)` via Multicall3
 *   3. Retorna borrowers com isLiquidatable=true
 *
 * Vantagens vs Aave:
 *   - Não depende de subgraph externo
 *   - Função `isLiquidatable()` é DEFINITIVA (não precisamos calcular HF)
 *   - Multicall3 escala bem (1000+ checks em ~3s)
 */

import { type Address, type PublicClient, parseAbi, parseAbiItem } from 'viem';

type AnyClient = PublicClient<any, any>;

const COMET_ABI = parseAbi([
  'function isLiquidatable(address account) view returns (bool)',
  'function baseToken() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
]);

// Event: Withdraw(address indexed src, address indexed to, uint256 amount)
const WITHDRAW_EVENT = parseAbiItem(
  'event Withdraw(address indexed src, address indexed to, uint256 amount)',
);

export interface CompoundLiquidatable {
  comet: Address;
  borrower: Address;
}

/**
 * Scan recente Comet pra encontrar borrowers que mexeram em position.
 * Default: últimos 10.000 blocos (~5h em Base, ~30min em Arb/OP).
 */
export async function fetchCompoundActiveBorrowers(opts: {
  client: AnyClient;
  comet: Address;
  blockLookback?: number;
}): Promise<Address[]> {
  const { client, comet, blockLookback = 10_000 } = opts;

  const currentBlock = await client.getBlockNumber();
  const fromBlock = currentBlock - BigInt(blockLookback);

  const logs = await client.getLogs({
    address: comet,
    event: WITHDRAW_EVENT,
    fromBlock,
    toBlock: 'latest',
  });

  // Dedupe por src (borrower)
  const uniqueBorrowers = new Set<Address>();
  for (const log of logs) {
    if (log.args.src) uniqueBorrowers.add(log.args.src);
  }
  return Array.from(uniqueBorrowers);
}

/**
 * Checa via Multicall3 quais borrowers são liquidáveis AGORA.
 * Compound III tem isLiquidatable() que retorna bool definitivo.
 */
export async function findLiquidatableBorrowers(opts: {
  client: AnyClient;
  comet: Address;
  borrowers: Address[];
}): Promise<CompoundLiquidatable[]> {
  const { client, comet, borrowers } = opts;
  if (borrowers.length === 0) return [];

  const contracts = borrowers.map((borrower) => ({
    address: comet,
    abi: COMET_ABI,
    functionName: 'isLiquidatable' as const,
    args: [borrower] as const,
  }));

  const results = await client.multicall({
    contracts,
    batchSize: 100,
    allowFailure: true,
  });

  const liquidatable: CompoundLiquidatable[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === 'success' && r.result === true) {
      liquidatable.push({ comet, borrower: borrowers[i]! });
    }
  }
  return liquidatable;
}

/**
 * Pipeline completo: discovery + check.
 * Retorna lista de borrowers liquidáveis AGORA pra um Comet específico.
 */
export async function scanCompoundLiquidatable(opts: {
  client: AnyClient;
  comet: Address;
  blockLookback?: number;
}): Promise<{ totalBorrowers: number; liquidatable: CompoundLiquidatable[] }> {
  const borrowers = await fetchCompoundActiveBorrowers(opts);
  const liquidatable = await findLiquidatableBorrowers({
    client: opts.client,
    comet: opts.comet,
    borrowers,
  });
  return { totalBorrowers: borrowers.length, liquidatable };
}
