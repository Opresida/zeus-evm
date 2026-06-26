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
import { UNISWAPX_REACTORS_BASE } from './abi';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/** Mapeia o `type` da API → endereço do reactor (a API não devolve `reactor` direto). */
function reactorForType(type: string | undefined): Address | null {
  switch (type) {
    case 'Dutch_V2':
      return UNISWAPX_REACTORS_BASE.v2DutchOrder;
    case 'Dutch_V3':
      return UNISWAPX_REACTORS_BASE.v3DutchOrder;
    default:
      return null; // Dutch (V1)/Priority/etc. — fora do nosso v1
  }
}

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
  minAmount?: string;
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
  swapper?: string;
  offerer?: string;
  deadline?: number;
  input?: ApiAmount;
  outputs?: ApiAmount[];
  cosignerData?: { exclusiveFiller?: string; inputOverride?: string; outputOverrides?: string[] };
}

function toBig(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '') return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** Amount conservador: override do cosigner (resolvido) > startAmount (máx que o filler pode dever). */
function amountOf(a: ApiAmount | undefined, override: string | undefined): bigint | null {
  const ov = toBig(override);
  if (ov !== null && ov > 0n) return ov;
  return toBig(a?.amount ?? a?.startAmount ?? a?.endAmount ?? a?.minAmount);
}

function mapOrder(o: ApiOrder): NormalizedOrder | null {
  const reactor = reactorForType(o.type);
  if (!reactor || !o.encodedOrder || !o.signature || !o.orderHash) return null;

  const inToken = o.input?.token;
  const inAmount = amountOf(o.input, o.cosignerData?.inputOverride);
  if (!inToken || inAmount === null || inAmount === 0n) return null;

  const overrides = o.cosignerData?.outputOverrides ?? [];
  const outputs: OrderOutput[] = [];
  const apiOuts = o.outputs ?? [];
  for (let i = 0; i < apiOuts.length; i++) {
    const out = apiOuts[i]!;
    const amt = amountOf(out, overrides[i]);
    if (!out.token || amt === null || !out.recipient) return null;
    outputs.push({ token: out.token as Address, amount: amt, recipient: out.recipient as Address });
  }
  if (outputs.length === 0) return null;

  const exclusive = o.cosignerData?.exclusiveFiller;
  return {
    reactor,
    orderHash: o.orderHash as Hex,
    swapper: (o.swapper ?? o.offerer ?? ZERO_ADDR) as Address,
    input: { token: inToken as Address, amount: inAmount },
    outputs,
    deadline: Number(o.deadline ?? 0), // 0 = desconhecido → confia no filtro orderStatus=open
    exclusiveFiller: exclusive && exclusive !== ZERO_ADDR ? (exclusive as Address) : undefined,
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
