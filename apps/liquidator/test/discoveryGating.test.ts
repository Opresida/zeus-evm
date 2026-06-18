/**
 * Fase 2 (H3) — discovery Aave/Seamless resiliente.
 * O subgraph é só acelerador: usa-se SOMENTE quando há subgraphId E TheGraph key.
 * Sem a key (ou sem subgraphId, ex: Seamless), cai no on-chain — que roda sempre.
 */

import { describe, expect, it } from 'vitest';
import { useSubgraphDiscovery } from '../src/index';

describe('useSubgraphDiscovery (H3)', () => {
  it('subgraph quando tem subgraphId E key', () => {
    expect(useSubgraphDiscovery(true, true)).toBe(true);
  });

  it('on-chain quando falta a key (Aave core sem TheGraph) → auto-feed do mercado', () => {
    expect(useSubgraphDiscovery(true, false)).toBe(false);
  });

  it('on-chain quando o market não tem subgraphId (ex: Seamless), mesmo com key', () => {
    expect(useSubgraphDiscovery(false, true)).toBe(false);
  });

  it('on-chain quando não há nem subgraphId nem key', () => {
    expect(useSubgraphDiscovery(false, false)).toBe(false);
  });
});
