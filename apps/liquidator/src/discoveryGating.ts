/**
 * H3 — decisão de caminho de discovery Aave por market (extraído pra ser testável sem
 * importar o index.ts, que executa main() no load).
 *
 * Subgraph só quando o market tem subgraphId E há TheGraph key; senão usa o on-chain
 * (event scan + BorrowerCache), que roda SEMPRE. Assim a descoberta nunca depende
 * exclusivamente da key (Seamless e Aave-sem-key continuam funcionando = auto-feed do mercado).
 */
export function useSubgraphDiscovery(hasSubgraphId: boolean, hasApiKey: boolean): boolean {
  return hasSubgraphId && hasApiKey;
}
