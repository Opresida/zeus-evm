/**
 * Market Inefficiency Scanner (MIS) — coração do Motor 2 (Doutrina, item 7).
 *
 * Varre GRUPOS de pools que negociam o mesmo par de tokens em DEXs/fee-tiers
 * diferentes, calcula o spot local de cada (sem RPC por quote), e detecta
 * divergências. O diferencial: ranqueia por PERSISTÊNCIA (magnitude × duração),
 * não por magnitude pura.
 *
 *   Ineficiência de 1 bloco  → guerra de latência → perdemos (descarta)
 *   Ineficiência PERSISTENTE → nosso edge (pool raso/esquecido, LSD off-peg)
 *
 * Reusa: pricing local (uniV3/aero), pool state reader, priceDivergenceBps,
 * token safety (só grupos allowlisted). Roda em observação pura — sem capital,
 * sem mempool. Alimenta o moat de dados (intelligenceStore via onSample).
 */

import type { Address, PublicClient } from 'viem';

import {
  readUniV3PoolState,
  readAeroPoolState,
  uniV3StateToSpot,
  aeroStateToSpot,
  priceDivergenceBps,
  arbDirection,
} from '@zeus-evm/dex-adapters';

type AnyPublicClient = PublicClient<any, any>;

export type PoolDex = 'univ3' | 'aerodrome';

/** Referência a um pool específico dentro de um grupo (mesmo par de tokens). */
export interface PoolRef {
  dex: PoolDex;
  pool: Address;
  /** Label legível (ex: 'UniV3-500', 'Aero-volatile'). */
  label: string;
}

/** Grupo de pools que negociam o MESMO par (tokenA/tokenB) em venues diferentes. */
export interface PoolGroup {
  /** Label do par (ex: 'WETH/USDC'). */
  label: string;
  tokenA: Address;
  tokenB: Address;
  decimalsA: number;
  decimalsB: number;
  pools: PoolRef[];
}

/** Resultado de 1 scan de um grupo. */
export interface InefficiencyObservation {
  groupLabel: string;
  timestamp: number;
  /** Maior divergência encontrada entre pools do grupo, em bps. */
  maxDivergenceBps: number;
  /** Pool mais barato (comprar) e mais caro (vender). */
  cheapPool?: string;
  expensivePool?: string;
  direction: 'buyA_sellB' | 'buyB_sellA' | 'none';
  /** Quantos pools tinham spot válido nesse scan. */
  poolsWithPrice: number;
}

export interface InefficiencyRanking {
  groupLabel: string;
  /** Score = taxa_de_persistência × diverg média (bps). Maior = melhor alvo. */
  score: number;
  /** % das amostras com divergência >= minDivergenceBps (persistência). */
  persistenceRatio: number;
  avgDivergenceBps: number;
  maxDivergenceBps: number;
  samples: number;
}

export interface MISOpts {
  /** Divergência mínima (bps) pra contar como "ineficiência" na persistência. Default 20 (0.2%). */
  minDivergenceBps?: number;
  /** Janela rolling em ms. Default 24h. */
  windowMs?: number;
  /** Cap de amostras por grupo (FIFO). Default 5000. */
  maxSamplesPerGroup?: number;
  /** Callback pra persistir cada observação (ex: intelligenceStore). */
  onSample?: (obs: InefficiencyObservation) => void;
}

const DEFAULT_MIN_DIV_BPS = 20;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SAMPLES = 5000;

export class MarketInefficiencyScanner {
  private readonly minDivergenceBps: number;
  private readonly windowMs: number;
  private readonly maxSamplesPerGroup: number;
  private readonly onSample: ((obs: InefficiencyObservation) => void) | undefined;

  private readonly groups = new Map<string, PoolGroup>();
  private readonly samples = new Map<string, InefficiencyObservation[]>();

  constructor(opts: MISOpts = {}) {
    this.minDivergenceBps = opts.minDivergenceBps ?? DEFAULT_MIN_DIV_BPS;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxSamplesPerGroup = opts.maxSamplesPerGroup ?? DEFAULT_MAX_SAMPLES;
    this.onSample = opts.onSample;
  }

  /** Registra um grupo de pools a monitorar. */
  registerGroup(group: PoolGroup): void {
    this.groups.set(group.label, group);
  }

  groupCount(): number {
    return this.groups.size;
  }

  /**
   * Lê o spot de cada pool de um grupo (via state reader + pricing local).
   * Retorna mapa poolLabel → spot (token1/token0, 1e18).
   */
  private async readGroupSpots(
    client: AnyPublicClient,
    group: PoolGroup,
  ): Promise<Array<{ label: string; spot: bigint }>> {
    const out: Array<{ label: string; spot: bigint }> = [];
    for (const ref of group.pools) {
      try {
        if (ref.dex === 'univ3') {
          const state = await readUniV3PoolState({ client, pool: ref.pool });
          if (!state) continue;
          // Normaliza pra spot tokenB-por-tokenA segundo a ordenação do pool
          const aIsToken0 = state.token0.toLowerCase() === group.tokenA.toLowerCase();
          const d0 = aIsToken0 ? group.decimalsA : group.decimalsB;
          const d1 = aIsToken0 ? group.decimalsB : group.decimalsA;
          let spot = uniV3StateToSpot(state, d0, d1); // token1 por token0
          if (!aIsToken0 && spot > 0n) spot = (10n ** 18n * 10n ** 18n) / spot; // inverte p/ B-por-A consistente
          if (spot > 0n) out.push({ label: ref.label, spot });
        } else {
          const state = await readAeroPoolState({ client, pool: ref.pool });
          if (!state) continue;
          const aIsToken0 = state.token0.toLowerCase() === group.tokenA.toLowerCase();
          const d0 = aIsToken0 ? group.decimalsA : group.decimalsB;
          const d1 = aIsToken0 ? group.decimalsB : group.decimalsA;
          let spot = aeroStateToSpot(state, d0, d1);
          if (!aIsToken0 && spot > 0n) spot = (10n ** 18n * 10n ** 18n) / spot;
          if (spot > 0n) out.push({ label: ref.label, spot });
        }
      } catch {
        // pool falhou — pula
      }
    }
    return out;
  }

  /**
   * Scan de UM grupo: lê spots, acha maior divergência, registra observação.
   */
  async scanGroup(client: AnyPublicClient, groupLabel: string): Promise<InefficiencyObservation | null> {
    const group = this.groups.get(groupLabel);
    if (!group) return null;

    const spots = await this.readGroupSpots(client, group);
    if (spots.length < 2) {
      return null; // precisa >= 2 pools pra comparar
    }

    // Acha o par com maior divergência
    let maxDiv = 0;
    let cheap: { label: string; spot: bigint } | undefined;
    let expensive: { label: string; spot: bigint } | undefined;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const div = priceDivergenceBps(spots[i]!.spot, spots[j]!.spot);
        if (div > maxDiv) {
          maxDiv = div;
          // menor spot = mais barato pra comprar tokenA
          if (spots[i]!.spot < spots[j]!.spot) {
            cheap = spots[i]; expensive = spots[j];
          } else {
            cheap = spots[j]; expensive = spots[i];
          }
        }
      }
    }

    const obs: InefficiencyObservation = {
      groupLabel,
      timestamp: Date.now(),
      maxDivergenceBps: maxDiv,
      cheapPool: cheap?.label,
      expensivePool: expensive?.label,
      direction: cheap && expensive ? arbDirection(cheap.spot, expensive.spot) : 'none',
      poolsWithPrice: spots.length,
    };

    this.recordSample(obs);
    this.onSample?.(obs);
    return obs;
  }

  /** Scan de TODOS os grupos. */
  async scanAll(client: AnyPublicClient): Promise<InefficiencyObservation[]> {
    const out: InefficiencyObservation[] = [];
    for (const label of this.groups.keys()) {
      const obs = await this.scanGroup(client, label);
      if (obs) out.push(obs);
    }
    return out;
  }

  /** Registra amostra no histórico rolling (uso interno + testável). */
  recordSample(obs: InefficiencyObservation): void {
    const list = this.samples.get(obs.groupLabel) ?? [];
    list.push(obs);
    if (list.length > this.maxSamplesPerGroup) list.shift();
    this.samples.set(obs.groupLabel, list);
    this._prune(list);
  }

  /**
   * Ranking por PERSISTÊNCIA × magnitude. Vencedor = onde vale concentrar.
   * score = persistenceRatio × avgDivergenceBps.
   */
  ranking(): InefficiencyRanking[] {
    const out: InefficiencyRanking[] = [];
    for (const [label, list] of this.samples.entries()) {
      this._prune(list);
      if (list.length === 0) continue;

      const persistent = list.filter((s) => s.maxDivergenceBps >= this.minDivergenceBps);
      const persistenceRatio = persistent.length / list.length;
      const avgDiv = list.reduce((acc, s) => acc + s.maxDivergenceBps, 0) / list.length;
      const maxDiv = list.reduce((acc, s) => Math.max(acc, s.maxDivergenceBps), 0);
      const score = persistenceRatio * avgDiv;

      out.push({
        groupLabel: label,
        score: Math.round(score * 100) / 100,
        persistenceRatio: Math.round(persistenceRatio * 1000) / 1000,
        avgDivergenceBps: Math.round(avgDiv * 100) / 100,
        maxDivergenceBps: maxDiv,
        samples: list.length,
      });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  stats(): { groups: number; totalSamples: number } {
    let total = 0;
    for (const list of this.samples.values()) total += list.length;
    return { groups: this.groups.size, totalSamples: total };
  }

  /**
   * Snapshot do histórico (pro padrão liga/desliga — persiste em disco + recarrega
   * no boot, acumulando persistência dia após dia mesmo sem rodar 24/7).
   */
  snapshot(): Record<string, InefficiencyObservation[]> {
    const out: Record<string, InefficiencyObservation[]> = {};
    for (const [label, list] of this.samples.entries()) {
      out[label] = [...list];
    }
    return out;
  }

  /** Restaura histórico de um snapshot (chamar no boot). Prune aplica a janela. */
  restore(data: Record<string, InefficiencyObservation[]>): void {
    for (const label of Object.keys(data)) {
      const list = (data[label] ?? []).slice(-this.maxSamplesPerGroup);
      this._prune(list);
      this.samples.set(label, list);
    }
  }

  private _prune(list: InefficiencyObservation[]): void {
    const cutoff = Date.now() - this.windowMs;
    while (list.length > 0 && (list[0]?.timestamp ?? 0) < cutoff) {
      list.shift();
    }
  }
}
