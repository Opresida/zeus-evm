/**
 * Aave V3 — discovery de positions via subgraph oficial em Base.
 *
 * Subgraph oficial: GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF (Aave V3 Base)
 * Acesso decentralizado via TheGraph Gateway requer API key (free em thegraph.com/studio).
 *
 * Estratégia:
 *   - Query periódica (a cada 30-60s) pra pegar TODOS users com debt > MIN_DEBT_USD
 *   - Filtra dust (positions < $100 não valem o gas)
 *   - Retorna lista de addresses pra healthFactor.ts processar on-chain
 *
 * Schema relevante:
 *   - User { id, reserves: UserReserve[] }
 *   - UserReserve { user, reserve, currentTotalDebt, currentATokenBalance, ... }
 */

import type { Address } from 'viem';

const GATEWAY_URL = 'https://gateway.thegraph.com/api';

export interface AavePosition {
  user: Address;
  totalDebtUsd: number;        // aprox via cache do subgraph (preciso só pra filtro)
  totalCollateralUsd: number;
  reserves: number;             // número de reserves usados (collateral + debt)
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface UserQueryResponse {
  users: Array<{
    id: string;
    reserves: Array<{
      currentTotalDebt: string;
      currentATokenBalance: string;
      reserve: {
        symbol: string;
        decimals: number;
        price: { priceInEth: string }; // 1e18 base
      };
    }>;
  }>;
}

/**
 * Query users com debt ativo no Aave V3 Base.
 * @param apiKey TheGraph API key (sign up em thegraph.com/studio)
 * @param subgraphId default: oficial Aave V3 Base
 * @param minDebtUsd filtra positions com debt total < min
 * @param ethPriceUsd usado pra converter ETH→USD (a base do subgraph é ETH)
 * @param first quantos users por página (default 100, max 1000)
 */
export async function fetchAaveV3Positions(opts: {
  apiKey: string;
  subgraphId: string;
  minDebtUsd?: number;
  ethPriceUsd?: number;
  first?: number;
  skip?: number;
}): Promise<AavePosition[]> {
  const { apiKey, subgraphId, minDebtUsd = 100, ethPriceUsd = 2110, first = 100, skip = 0 } = opts;

  if (!apiKey) {
    throw new Error('THEGRAPH_API_KEY obrigatório — sign up em https://thegraph.com/studio/');
  }

  // Query: users que têm pelo menos 1 reserve com debt > 0
  // Importante: schema real da Aave subgraph pode variar. Esta é a query base
  // pra Aave V3 — campos exatos podem precisar ajuste após primeira execução.
  const query = `
    query Positions($first: Int!, $skip: Int!) {
      users(
        first: $first
        skip: $skip
        where: { borrowedReservesCount_gt: 0 }
        orderBy: id
      ) {
        id
        reserves(where: { currentTotalDebt_gt: "0" }) {
          currentTotalDebt
          currentATokenBalance
          reserve {
            symbol
            decimals
            price { priceInEth }
          }
        }
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
    throw new Error(`Subgraph HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as GraphQLResponse<UserQueryResponse>;
  if (json.errors) {
    throw new Error(`Subgraph errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) {
    return [];
  }

  const positions: AavePosition[] = [];

  for (const u of json.data.users) {
    let debtUsd = 0;
    let collateralUsd = 0;
    let reserveCount = 0;

    for (const r of u.reserves) {
      const priceEth = Number(r.reserve.price.priceInEth) / 1e18;
      const priceUsd = priceEth * ethPriceUsd;
      const debtTokens = Number(r.currentTotalDebt) / Math.pow(10, r.reserve.decimals);
      const collTokens = Number(r.currentATokenBalance) / Math.pow(10, r.reserve.decimals);
      debtUsd += debtTokens * priceUsd;
      collateralUsd += collTokens * priceUsd;
      reserveCount++;
    }

    if (debtUsd >= minDebtUsd) {
      positions.push({
        user: u.id as Address,
        totalDebtUsd: debtUsd,
        totalCollateralUsd: collateralUsd,
        reserves: reserveCount,
      });
    }
  }

  return positions;
}

/**
 * Pagina por todas as positions. Cuidado: pode ser MUITO (10k+ users no Aave Base).
 * Default cap: 5000 users (50 páginas de 100).
 */
export async function fetchAllAaveV3Positions(opts: {
  apiKey: string;
  subgraphId: string;
  minDebtUsd?: number;
  ethPriceUsd?: number;
  maxUsers?: number;
}): Promise<AavePosition[]> {
  const { maxUsers = 5000 } = opts;
  const pageSize = 100;
  const allPositions: AavePosition[] = [];
  let skip = 0;

  while (skip < maxUsers) {
    const page = await fetchAaveV3Positions({ ...opts, first: pageSize, skip });
    if (page.length === 0) break;
    allPositions.push(...page);
    if (page.length < pageSize) break; // última página
    skip += pageSize;
  }

  return allPositions;
}
