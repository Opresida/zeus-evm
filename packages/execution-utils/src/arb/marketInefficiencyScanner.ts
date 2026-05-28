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
  uniV3SpotPrice1e18,
  aeroSpotPrice1e18,
  UNIV3_POOL_ABI,
  AERO_POOL_ABI,
} from '@zeus-evm/dex-adapters';

const WAD = 10n ** 18n;

type AnyPublicClient = PublicClient<any, any>;

export type PoolDex = 'univ3' | 'aerodrome';

/** Referência a um pool específico dentro de um grupo (mesmo par de tokens). */
export interface PoolRef {
  dex: PoolDex;
  pool: Address;
  /** Label legível (ex: 'UniV3-500', 'Aero-volatile'). */
  label: string;
  /** Aerodrome: stable (true) ou volatile (false). Imutável — cacheado no resolve. */
  stable?: boolean;
  /** UniV3: fee tier (100/500/3000/10000) — pro quoter. Imutável — cacheado no resolve. */
  fee?: number;
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
  /**
   * Divergência MÁXIMA sã (bps). Acima disso = provável lixo (pool morto/desbalanceado),
   * não oportunidade real — descartado. Default 1500 (15%). Arb real raramente > alguns %.
   */
  maxSaneDivergenceBps?: number;
  /** Janela rolling em ms. Default 24h. */
  windowMs?: number;
  /** Cap de amostras por grupo (FIFO). Default 5000. */
  maxSamplesPerGroup?: number;
  /** Callback pra persistir cada observação (ex: intelligenceStore). */
  onSample?: (obs: InefficiencyObservation) => void;
}

const DEFAULT_MIN_DIV_BPS = 20;
const DEFAULT_MAX_SANE_DIV_BPS = 1500;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SAMPLES = 5000;

export class MarketInefficiencyScanner {
  private readonly minDivergenceBps: number;
  private readonly maxSaneDivergenceBps: number;
  private readonly windowMs: number;
  private readonly maxSamplesPerGroup: number;
  private readonly onSample: ((obs: InefficiencyObservation) => void) | undefined;

  private readonly groups = new Map<string, PoolGroup>();
  private readonly samples = new Map<string, InefficiencyObservation[]>();
  /** Grupos marcados como "rasos" (pool não suporta o notional) — excluídos do ranking. */
  private readonly thinGroups = new Set<string>();

  constructor(opts: MISOpts = {}) {
    this.minDivergenceBps = opts.minDivergenceBps ?? DEFAULT_MIN_DIV_BPS;
    this.maxSaneDivergenceBps = opts.maxSaneDivergenceBps ?? DEFAULT_MAX_SANE_DIV_BPS;
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
   * Marca/desmarca um grupo como "raso" (pool não suporta o notional alvo —
   * slippage devora o trade). Rasos NÃO entram no ranking de persistência:
   * divergência de spot num pool raso é lixo, não oportunidade.
   */
  markThin(label: string, isThin: boolean): void {
    if (isThin) this.thinGroups.add(label);
    else this.thinGroups.delete(label);
  }

  isThin(label: string): boolean {
    return this.thinGroups.has(label);
  }

  thinCount(): number {
    return this.thinGroups.size;
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
    const obs = this._buildObservation(groupLabel, spots);
    if (!obs) return null;
    this.recordSample(obs);
    this.onSample?.(obs);
    return obs;
  }

  /**
   * Helper: dado os spots de um grupo, acha a maior divergência e monta a observação.
   * Retorna null se < 2 pools com preço.
   */
  private _buildObservation(
    groupLabel: string,
    spots: Array<{ label: string; spot: bigint }>,
  ): InefficiencyObservation | null {
    if (spots.length < 2) return null;
    let maxDiv = 0;
    let cheap: { label: string; spot: bigint } | undefined;
    let expensive: { label: string; spot: bigint } | undefined;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const div = priceDivergenceBps(spots[i]!.spot, spots[j]!.spot);
        // Sanity: divergência absurda = pool morto/desbalanceado, não oportunidade real
        if (div > this.maxSaneDivergenceBps) continue;
        if (div > maxDiv) {
          maxDiv = div;
          if (spots[i]!.spot < spots[j]!.spot) { cheap = spots[i]; expensive = spots[j]; }
          else { cheap = spots[j]; expensive = spots[i]; }
        }
      }
    }
    return {
      groupLabel,
      timestamp: Date.now(),
      maxDivergenceBps: maxDiv,
      cheapPool: cheap?.label,
      expensivePool: expensive?.label,
      direction: cheap && expensive ? arbDirection(cheap.spot, expensive.spot) : 'none',
      poolsWithPrice: spots.length,
    };
  }

  /** Scan de TODOS os grupos (1 multicall por grupo — legado). */
  async scanAll(client: AnyPublicClient): Promise<InefficiencyObservation[]> {
    const out: InefficiencyObservation[] = [];
    for (const label of this.groups.keys()) {
      const obs = await this.scanGroup(client, label);
      if (obs) out.push(obs);
    }
    return out;
  }

  /**
   * Scan BATCHED — 1 (poucos) multicall(s) pra TODOS os pools de TODOS os grupos.
   *
   * Só lê o dado DINÂMICO (slot0/getReserves); token0/decimals/stable são imutáveis
   * (ordenação determinística por endereço + stable cacheado no PoolRef). Reduz de
   * N×5 calls pra ~N calls num round-trip — essencial pra escalar pra dezenas de pares.
   */
  async scanAllBatched(client: AnyPublicClient): Promise<InefficiencyObservation[]> {
    type Idx = { group: PoolGroup; ref: PoolRef; aIsToken0: boolean };
    const calls: Array<{ address: Address; abi: unknown; functionName: string }> = [];
    const index: Idx[] = [];

    for (const group of this.groups.values()) {
      const aIsToken0 = group.tokenA.toLowerCase() < group.tokenB.toLowerCase();
      for (const ref of group.pools) {
        if (ref.dex === 'univ3') {
          calls.push({ address: ref.pool, abi: UNIV3_POOL_ABI, functionName: 'slot0' });
        } else {
          calls.push({ address: ref.pool, abi: AERO_POOL_ABI, functionName: 'getReserves' });
        }
        index.push({ group, ref, aIsToken0 });
      }
    }
    if (calls.length === 0) return [];

    const results = (await client.multicall({ contracts: calls as never, allowFailure: true })) as Array<
      { status: 'success'; result: unknown } | { status: 'failure'; error: unknown }
    >;

    // Agrupa spots por grupo
    const spotsByGroup = new Map<string, Array<{ label: string; spot: bigint }>>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status !== 'success') continue;
      const { group, ref, aIsToken0 } = index[i]!;
      const d0 = aIsToken0 ? group.decimalsA : group.decimalsB;
      const d1 = aIsToken0 ? group.decimalsB : group.decimalsA;

      let spot: bigint;
      if (ref.dex === 'univ3') {
        const s = r.result as readonly [bigint, number, number, number, number, number, boolean];
        spot = uniV3SpotPrice1e18(s[0], d0, d1);
      } else {
        const res = r.result as readonly [bigint, bigint, bigint];
        spot = aeroSpotPrice1e18(ref.stable ?? false, res[0], res[1], d0, d1);
      }
      if (spot <= 0n) continue;
      // Normaliza pra "tokenB por tokenA" consistente (inverte se A não é token0)
      if (!aIsToken0) spot = (WAD * WAD) / spot;

      const list = spotsByGroup.get(group.label) ?? [];
      list.push({ label: ref.label, spot });
      spotsByGroup.set(group.label, list);
    }

    const out: InefficiencyObservation[] = [];
    for (const [label, spots] of spotsByGroup.entries()) {
      const obs = this._buildObservation(label, spots);
      if (obs) {
        this.recordSample(obs);
        this.onSample?.(obs);
        out.push(obs);
      }
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
      if (this.thinGroups.has(label)) continue; // raso = pool não suporta notional → fora
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
