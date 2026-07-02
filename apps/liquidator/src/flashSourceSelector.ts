/**
 * Seletor de fonte de flashloan — escolhe a fonte mais barata COM liquidez suficiente.
 *
 * Prioridade econômica: Morpho (0%) → Balancer (0%) → Aave (0,05% fallback universal).
 *
 * Inspirado no `FlashloanAdapter` da Enso (docs.enso.build/pages/build/reference/flashloans):
 * a fonte do empréstimo é SELECIONÁVEL, não hardcoded. Aqui a seleção é off-chain — o contrato
 * apenas executa o caminho escolhido (campo `flashSource` no struct de params).
 *
 * Liquidez:
 *   - Morpho Blue: flashloan acessa o saldo INTEIRO do token no singleton (todos os markets +
 *     colateral combinados). Probe = balanceOf(token) no singleton.
 *   - Balancer V2 Vault: flashloan acessa o saldo do token no Vault. Probe = balanceOf(token) no vault.
 *
 * Segurança/correção: a escolha de uma fonte 0% NÃO altera o profit math (que permanece
 * conservador a 0,05% nos calculators). O ganho de 5bps é capturado on-chain ao usar a fonte 0%.
 */

import type { Address, PublicClient } from 'viem';
import type { ChainConfig } from '@zeus-evm/chain-config';
import { FlashSource, FLASH_SOURCE_PREMIUM_BPS } from './types';

type AnyPublicClient = PublicClient<any, any>;

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'account' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export interface FlashSourceSelection {
  flashSource: FlashSource;
  flashPremiumBps: bigint;
}

export interface FlashLiquidity {
  morpho: bigint;
  balancer: bigint;
}

/**
 * Decisão pura: dada a quantia e a liquidez disponível em cada fonte 0%, escolhe a melhor.
 * Aplica uma margem de segurança (`bufferBps`) sobre o `amount` exigido — a liquidez precisa
 * cobrir o empréstimo COM folga, senão o flashloan reverte (não perde dinheiro, perde a oportunidade).
 *
 * Determinística e sem I/O → unit-testável isoladamente.
 */
export function pickFlashSourceByLiquidity(
  amount: bigint,
  liquidity: FlashLiquidity,
  bufferBps = 100n, // exige 1% a mais de liquidez que o empréstimo, por segurança
): FlashSourceSelection {
  const required = (amount * (10_000n + bufferBps)) / 10_000n;

  // Morpho primeiro (liquidez tipicamente mais funda em tokens majoritários na Base).
  if (liquidity.morpho >= required) {
    return { flashSource: FlashSource.Morpho, flashPremiumBps: FLASH_SOURCE_PREMIUM_BPS[FlashSource.Morpho] };
  }
  if (liquidity.balancer >= required) {
    return { flashSource: FlashSource.Balancer, flashPremiumBps: FLASH_SOURCE_PREMIUM_BPS[FlashSource.Balancer] };
  }
  // Fallback universal: Aave 0,05%.
  return { flashSource: FlashSource.Aave, flashPremiumBps: FLASH_SOURCE_PREMIUM_BPS[FlashSource.Aave] };
}

/**
 * Lê o saldo do `token` no singleton Morpho e no Vault Balancer (1 multicall).
 * Se a chain não tiver Morpho/Balancer configurado, a respectiva liquidez retorna 0n
 * (→ aquela fonte nunca é escolhida; cai pro fallback Aave).
 */
export async function probeFlashLiquidity(
  client: AnyPublicClient,
  chainConfig: ChainConfig,
  token: Address,
): Promise<FlashLiquidity> {
  const morphoAddr = chainConfig.morpho?.morphoBlue;
  const balancerAddr = chainConfig.balancer?.vault;

  const calls: { address: Address; abi: typeof ERC20_BALANCE_OF_ABI; functionName: 'balanceOf'; args: [Address] }[] = [];
  if (morphoAddr) calls.push({ address: token, abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [morphoAddr] });
  if (balancerAddr) calls.push({ address: token, abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [balancerAddr] });

  if (calls.length === 0) return { morpho: 0n, balancer: 0n };

  const results = await client.multicall({ contracts: calls, allowFailure: true });

  let idx = 0;
  let morpho = 0n;
  let balancer = 0n;
  if (morphoAddr) {
    const r = results[idx++];
    morpho = r?.status === 'success' ? (r.result as bigint) : 0n;
  }
  if (balancerAddr) {
    const r = results[idx++];
    balancer = r?.status === 'success' ? (r.result as bigint) : 0n;
  }
  return { morpho, balancer };
}

/**
 * Seleção end-to-end: probe on-chain + decisão pura.
 * Em qualquer erro de RPC, faz fail-safe pro Aave (sempre funciona).
 */
/** Nome curto da fonte pra observabilidade (#13 saúde do flashloan). */
export function flashSourceKey(fs: FlashSource): 'morpho' | 'balancer' | 'aave' {
  return fs === FlashSource.Morpho ? 'morpho' : fs === FlashSource.Balancer ? 'balancer' : 'aave';
}

export async function selectFlashSource(
  client: AnyPublicClient,
  chainConfig: ChainConfig,
  token: Address,
  amount: bigint,
  /** #13 automação (observe-first) — registra a fonte escolhida (opcional). */
  flashHealth?: { observe: (key: string) => void },
): Promise<FlashSourceSelection> {
  let sel: FlashSourceSelection;
  try {
    const liquidity = await probeFlashLiquidity(client, chainConfig, token);
    sel = pickFlashSourceByLiquidity(amount, liquidity);
  } catch {
    sel = { flashSource: FlashSource.Aave, flashPremiumBps: FLASH_SOURCE_PREMIUM_BPS[FlashSource.Aave] };
  }
  flashHealth?.observe(flashSourceKey(sel.flashSource));
  return sel;
}
