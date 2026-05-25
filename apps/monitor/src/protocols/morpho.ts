/**
 * Morpho Blue — discovery de positions liquidáveis via subgraph oficial.
 *
 * Morpho tem markets isolados — cada par (loanToken, collateralToken, oracle, irm, lltv)
 * é um market separado com identificador único (bytes32).
 *
 * Estratégia:
 *   1. Query subgraph Messari-format `morpho-blue-base` listando positions side=BORROWER com balance>0
 *   2. Cada Position é UMA perna (debt OU collateral, não ambas):
 *      - account.id  → borrower
 *      - market.id   → marketId bytes32 (Morpho Blue)
 *      - asset       → loanToken (quando side=BORROWER é o token sendo emprestado)
 *      - balance     → debt em wei do loanToken
 *      - market.inputToken → collateralToken (no Messari schema o "input" do market é o colateral)
 *      - market.oracle.oracleAddress → oracle do market
 *      - market.liquidationThreshold → LLTV (BigDecimal "0.945" → precisa virar WAD 945e15)
 *   3. ⚠️ Campo `irm` NÃO existe no subgraph — precisa enrichment on-chain via
 *      `Morpho.idToMarketParams(marketId)` antes de qualquer dispatch real.
 *   4. Filtra por debt mínimo (em loanToken wei — aprox via decimals)
 *
 * Subgraph oficial Base: 8Lz789DP5VKLXumTMTgygjU2xtuzx8AhbaacgN5PYCAs (Messari morpho-blue-base)
 */

import type { Address } from 'viem';
import { parseUnits, zeroAddress } from 'viem';

const GATEWAY_URL = 'https://gateway.thegraph.com/api';

export interface MorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface MorphoLiquidatablePosition {
  borrower: Address;
  marketId: `0x${string}`;
  marketParams: MorphoMarketParams;
  /** Wei do loanToken (debt atual = position.balance quando side=BORROWER). */
  borrowAmount: bigint;
  /** Decimals do loanToken — útil pra converter pra USD off-chain. */
  loanTokenDecimals: number;
  /** Symbol do loanToken (apenas log/diagnóstico). */
  loanTokenSymbol: string;
  /**
   * Indica que `marketParams.irm` veio como zeroAddress placeholder e PRECISA
   * ser preenchido via `Morpho.idToMarketParams(marketId)` on-chain antes de
   * qualquer dispatch real ao ZeusExecutor.executeMorphoLiquidation.
   */
  irmResolved: boolean;
  /** HF teórico — não computado aqui (calcular on-chain quando necessário). */
  healthFactor: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface SubgraphPositionResponse {
  positions: Array<{
    account: { id: string };
    market: {
      id: string;
      inputToken: { id: string; symbol: string; decimals: number };
      oracle: { oracleAddress: string } | null;
      liquidationThreshold: string;
    };
    asset: { id: string; symbol: string; decimals: number };
    side: 'BORROWER' | 'SUPPLIER' | 'COLLATERAL';
    balance: string;
  }>;
}

/**
 * Converte LLTV em BigDecimal ("0.945") pra WAD (945000000000000000n).
 * Usa parseUnits do viem pra evitar IEEE754 drift.
 */
function lltvDecimalToWad(decimal: string): bigint {
  if (!decimal || decimal === '0') return 0n;
  return parseUnits(decimal, 18);
}

/**
 * Lista positions BORROWER ativas, ordenadas por balance desc.
 * Pra cada position retornada, `marketParams.irm` virá como zeroAddress
 * (subgraph não expõe esse campo) — enrichment on-chain é obrigatório
 * antes de dispatch real ao executeMorphoLiquidation.
 */
export async function fetchMorphoPositions(opts: {
  apiKey: string;
  subgraphId: string; // ex: 8Lz789DP5VKLXumTMTgygjU2xtuzx8AhbaacgN5PYCAs (Base)
  first?: number;
  skip?: number;
}): Promise<MorphoLiquidatablePosition[]> {
  const { apiKey, subgraphId, first = 100, skip = 0 } = opts;

  if (!apiKey) {
    throw new Error('THEGRAPH_API_KEY obrigatório');
  }

  const query = `
    query Positions($first: Int!, $skip: Int!) {
      positions(
        first: $first
        skip: $skip
        where: { side: BORROWER, balance_gt: "0" }
        orderBy: balance
        orderDirection: desc
      ) {
        account { id }
        market {
          id
          inputToken { id symbol decimals }
          oracle { oracleAddress }
          liquidationThreshold
        }
        asset { id symbol decimals }
        side
        balance
      }
    }
  `;

  const url = `${GATEWAY_URL}/${apiKey}/subgraphs/id/${subgraphId}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { first, skip } }),
  });

  if (!res.ok) {
    throw new Error(`Morpho subgraph HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as GraphQLResponse<SubgraphPositionResponse>;
  if (json.errors) {
    throw new Error(`Morpho subgraph errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) return [];

  const positions: MorphoLiquidatablePosition[] = [];
  for (const p of json.data.positions) {
    // Markets sem oracle são inválidos/legacy — skip
    if (!p.market.oracle?.oracleAddress) continue;

    positions.push({
      borrower: p.account.id as Address,
      marketId: p.market.id as `0x${string}`,
      marketParams: {
        loanToken: p.asset.id as Address,
        collateralToken: p.market.inputToken.id as Address,
        oracle: p.market.oracle.oracleAddress as Address,
        irm: zeroAddress, // ⚠️ enrichment on-chain obrigatório antes de dispatch
        lltv: lltvDecimalToWad(p.market.liquidationThreshold),
      },
      borrowAmount: BigInt(p.balance),
      loanTokenDecimals: p.asset.decimals,
      loanTokenSymbol: p.asset.symbol,
      irmResolved: false,
      healthFactor: 0,
    });
  }

  return positions;
}
