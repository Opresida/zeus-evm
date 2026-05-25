/**
 * Morpho Blue — discovery de positions liquidáveis via subgraph oficial.
 *
 * Morpho tem markets isolados — cada par (loanToken, collateralToken, oracle, irm, lltv)
 * é um market separado com identificador único (bytes32).
 *
 * Estratégia:
 *   1. Query subgraph oficial Morpho Blue (Base) pra listar positions com healthFactor < threshold
 *   2. Pra cada position retornada, temos:
 *      - borrower address
 *      - market id + marketParams completos (5 campos)
 *      - collateral / borrow amounts
 *   3. Filtra por debt mínimo
 *   4. Retorna lista pronta pra dispatch
 *
 * Subgraph oficial Base: 8Lz789DP5VKLXumTMTgygjU2xtuzx8AhbaacgN5PYCAs (mesma estrutura nas outras chains)
 *
 * 🚧 TODO: schema do subgraph oficial é diferente do que assumimos no MVP.
 * Erros recebidos:
 *   - Type `Position` has no field `user` (provável: `borrower` ou `id`)
 *   - Type `Market` has no field `loanAsset` (provável: `loanToken`)
 *   - Type `Market` has no field `collateralAsset` (provável: `collateralToken`)
 *   - Type `Position` has no field `borrowAssets` (provável: `borrow` ou `principal`)
 *
 * Próxima sessão: rodar introspection query pra descobrir schema real, ajustar.
 * Por enquanto: contrato + monitor preparados, schema-fix é trivial.
 */

import type { Address } from 'viem';

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
  collateralAmount: bigint;     // wei do collateralToken
  borrowAmount: bigint;          // wei do loanToken (debt atual)
  healthFactor: number;          // 1.0 = peg liquidation
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface SubgraphPositionResponse {
  positions: Array<{
    user: { id: string };
    market: {
      id: string;
      loanAsset: { id: string };
      collateralAsset: { id: string };
      oracle: { id: string } | null;
      irm: { id: string } | null;
      lltv: string;
    };
    collateral: string;
    borrowShares: string;
    borrowAssets: string;
  }>;
}

/**
 * Lista positions com debt > min, ordenadas por borrowAssets desc.
 * Pra filtrar por HF requer chamada on-chain extra — fazer em separado.
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

  // Schema Morpho subgraph: positions(where: { borrowAssets_gt: 0 })
  // Campos exatos dependem da versão do subgraph — pode precisar ajuste após primeira execução
  const query = `
    query Positions($first: Int!, $skip: Int!) {
      positions(
        first: $first
        skip: $skip
        where: { borrowAssets_gt: "0" }
        orderBy: borrowAssets
        orderDirection: desc
      ) {
        user { id }
        market {
          id
          loanAsset { id }
          collateralAsset { id }
          oracle { id }
          irm { id }
          lltv
        }
        collateral
        borrowShares
        borrowAssets
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
    // Algumas positions podem ter oracle/irm nulos (markets antigos/inválidos) — skip
    if (!p.market.oracle?.id || !p.market.irm?.id) continue;

    positions.push({
      borrower: p.user.id as Address,
      marketId: p.market.id as `0x${string}`,
      marketParams: {
        loanToken: p.market.loanAsset.id as Address,
        collateralToken: p.market.collateralAsset.id as Address,
        oracle: p.market.oracle.id as Address,
        irm: p.market.irm.id as Address,
        lltv: BigInt(p.market.lltv),
      },
      collateralAmount: BigInt(p.collateral),
      borrowAmount: BigInt(p.borrowAssets),
      healthFactor: 0, // calcular on-chain se quiser precisão
    });
  }

  return positions;
}
