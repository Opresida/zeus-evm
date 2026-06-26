/**
 * Motor 2 / Filler UniswapX — feed de ordens abertas (polling da API da UniswapX).
 *
 * A API entrega as ordens DECODIFICADAS (input/outputs + amounts em JSON). Aqui só fazemos o polling +
 * mapeamento pro nosso `NormalizedOrder`. Fail-safe: erro/resposta malformada → lista vazia (não inventa).
 *
 * ⚠️ O shape EXATO dos campos da API deve ser validado contra a resposta real no DRY_RUN (F4) — o
 * mapeamento abaixo é defensivo e cobre os campos documentados; ajustar quando vermos o JSON ao vivo.
 * Decaimento holandês: usamos o amount RESOLVIDO/atual quando a API o fornece; senão, o endAmount
 * (conservador — o pior preço pro filler, então nunca superestima o lucro).
 */

import type { Address, Hex } from 'viem';
import type { NormalizedOrder, OrderOutput } from './types';

export interface OrderFeedOpts {
  /** Base da API UniswapX. Default: endpoint público v2. */
  apiBase?: string;
  chainId: number;
  /** Timeout do fetch (ms). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  limit?: number;
}

interface ApiAmount {
  token?: string;
  startAmount?: string;
  endAmount?: string;
  amount?: string; // resolvido (quando presente)
  recipient?: string;
}
interface ApiOrder {
  type?: string;
  orderStatus?: string;
  encodedOrder?: string;
  signature?: string;
  orderHash?: string;
  chainId?: number;
  reactor?: string;
  swapper?: string;
  offerer?: string;
  deadline?: number;
  input?: ApiAmount;
  outputs?: ApiAmount[];
}

/** Pega o amount "atual/conservador": resolvido > endAmount (pior pro filler) > startAmount. */
function currentAmount(a: ApiAmount | undefined): bigint | null {
  const raw = a?.amount ?? a?.endAmount ?? a?.startAmount;
  if (raw === undefined) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

function mapOrder(o: ApiOrder): NormalizedOrder | null {
  if (!o.encodedOrder || !o.signature || !o.orderHash || !o.reactor) return null;
  const inToken = o.input?.token;
  const inAmount = currentAmount(o.input);
  if (!inToken || inAmount === null) return null;

  const outputs: OrderOutput[] = [];
  for (const out of o.outputs ?? []) {
    const amt = currentAmount(out);
    if (!out.token || amt === null || !out.recipient) return null;
    outputs.push({ token: out.token as Address, amount: amt, recipient: out.recipient as Address });
  }
  if (outputs.length === 0) return null;

  return {
    reactor: o.reactor as Address,
    orderHash: o.orderHash as Hex,
    swapper: (o.swapper ?? o.offerer ?? '0x0000000000000000000000000000000000000000') as Address,
    input: { token: inToken as Address, amount: inAmount },
    outputs,
    deadline: Number(o.deadline ?? 0),
    signedOrder: o.encodedOrder as Hex,
    signature: o.signature as Hex,
  };
}

/** Puxa as ordens ABERTAS da Base. Fail-safe: qualquer erro → []. */
export async function fetchOpenOrders(opts: OrderFeedOpts): Promise<NormalizedOrder[]> {
  const {
    apiBase = 'https://api.uniswap.org/v2',
    chainId,
    timeoutMs = 4_000,
    fetchImpl = fetch,
    limit = 100,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${apiBase.replace(/\/$/, '')}/orders?chainId=${chainId}&orderStatus=open&limit=${limit}`;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) return [];
    const body = (await res.json()) as { orders?: ApiOrder[] };
    if (!Array.isArray(body.orders)) return [];
    const out: NormalizedOrder[] = [];
    for (const o of body.orders) {
      const m = mapOrder(o);
      if (m) out.push(m);
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
