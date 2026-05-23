/**
 * Aave V3 — discovery de candidatos via subgraph oficial em Base.
 *
 * Subgraph oficial: GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF (Aave V3 Base)
 *
 * IMPORTANTE — descoberta IMPORTANTE durante implementação:
 *   O campo `currentTotalDebt` no subgraph é PRINCIPAL debt em wei, NÃO o
 *   scaled debt × liquidityIndex (que dá o debt real com juros). Por isso
 *   queries que filtram por `currentTotalDebt_gt: X` retornam valores zerados
 *   ou desatualizados.
 *
 *   SOLUÇÃO: subgraph serve APENAS pra listar candidatos (users com
 *   `borrowedReservesCount > 0`). O filtro de "debt real ≥ X USD" e
 *   "HF < 1.0" é feito ON-CHAIN via `IPool.getUserAccountData()` que retorna
 *   `totalDebtBase` e `healthFactor` EXATOS no bloco atual.
 *
 *   Trade-off: mais chamadas RPC (1 por candidato), mas precisão garantida.
 */

import type { Address } from 'viem';

const GATEWAY_URL = 'https://gateway.thegraph.com/api';

/** Apenas o endereço — debt/collateral/HF reais vêm on-chain via getUserAccountData */
export interface AaveCandidate {
  user: Address;
  borrowedReservesCount: number; // quantos reserves o user tem com debt (proxy de complexidade)
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface UserQueryResponse {
  users: Array<{
    id: string;
    borrowedReservesCount: number;
  }>;
}

/**
 * Query lista de candidatos pra liquidação no Aave V3 Base.
 *
 * Retorna users com pelo menos 1 reserve emprestado, ordenados por
 * `borrowedReservesCount desc` (proxy de "position complexa, mais likely de variar HF").
 *
 * NÃO filtra por debt — isso é feito on-chain depois (mais preciso).
 */
export async function fetchAaveV3Candidates(opts: {
  apiKey: string;
  subgraphId: string;
  first?: number;
  skip?: number;
}): Promise<AaveCandidate[]> {
  const { apiKey, subgraphId, first = 100, skip = 0 } = opts;

  if (!apiKey) {
    throw new Error('THEGRAPH_API_KEY obrigatório — sign up em https://thegraph.com/studio/');
  }

  const query = `
    query Candidates($first: Int!, $skip: Int!) {
      users(
        first: $first
        skip: $skip
        where: { borrowedReservesCount_gt: 0 }
        orderBy: borrowedReservesCount
        orderDirection: desc
      ) {
        id
        borrowedReservesCount
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
  if (!json.data) return [];

  return json.data.users.map((u) => ({
    user: u.id as Address,
    borrowedReservesCount: u.borrowedReservesCount,
  }));
}

/**
 * Pagina por todos os candidatos. Cap default: 1000 users.
 * (Aave Base tem ~5k-10k borrowers ativos; 1000 cobre os "complexos" mais relevantes)
 */
export async function fetchAllAaveV3Candidates(opts: {
  apiKey: string;
  subgraphId: string;
  maxUsers?: number;
}): Promise<AaveCandidate[]> {
  const { maxUsers = 1000 } = opts;
  const pageSize = 100;
  const all: AaveCandidate[] = [];
  let skip = 0;

  while (skip < maxUsers) {
    const page = await fetchAaveV3Candidates({ ...opts, first: pageSize, skip });
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    skip += pageSize;
  }

  return all;
}
