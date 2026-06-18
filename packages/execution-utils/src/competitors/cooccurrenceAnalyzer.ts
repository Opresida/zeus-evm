/**
 * CooccurrenceAnalyzer — Item 5 F8 do checklist.
 *
 * Detecta senders que aparecem JUNTOS na mesma janela (mesmo bloco ou ±N blocos).
 *
 * Por que importa:
 *  - Mesmo operador usa MÚLTIPLAS wallets (sybil) — cooccurrence revela
 *  - Sandwich bots: frontrun-wallet + backrun-wallet sempre juntos
 *  - Coordinated MEV: vários endereços operando como cluster
 *  - JIT liquidity providers: aparecem em volta da mesma swap-alvo
 *
 * Saída: graph de cooccurrence + clusters detectados via threshold.
 *
 * Stateful: mantém janela rolling de observações + matriz esparsa de counts.
 */

import type { Address } from 'viem';

export interface BlockObservation {
  block_number: bigint;
  timestamp: number;
  /** Senders únicos que apareceram nesse bloco. */
  senders: Address[];
}

export interface CooccurrenceLink {
  sender_a: Address;
  sender_b: Address;
  /** Quantas vezes apareceram no mesmo bloco. */
  cooccurrences: number;
  /** Total de blocos em que sender_a apareceu. */
  total_a: number;
  /** Total de blocos em que sender_b apareceu. */
  total_b: number;
  /** Jaccard similarity: cooccurrences / (total_a + total_b - cooccurrences). */
  jaccard: number;
  /** Probabilidade condicional P(b | a). */
  conditional_b_given_a: number;
}

export interface CooccurrenceCluster {
  members: Address[];
  avg_jaccard: number;
  /** Total de blocos onde QUALQUER membro apareceu. */
  total_blocks_seen: number;
}

export interface CooccurrenceAnalyzerOpts {
  /** Window rolling em ms. Default 24h. */
  windowMs?: number;
  /** Cap de observations em memória. Default 50k. */
  maxObservations?: number;
  /** Min cooccurrences pra reportar link. Default 5. */
  minCooccurrences?: number;
  /** Min jaccard pra considerar "fortemente correlacionado". Default 0.4. */
  minJaccard?: number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OBS = 50_000;
const DEFAULT_MIN_COOCC = 5;
const DEFAULT_MIN_JACCARD = 0.4;

/**
 * Stateful analyzer rolling window.
 *
 * Uso típico (chamado pelo blockHistoryScanner):
 *   const analyzer = new CooccurrenceAnalyzer();
 *   for each block:
 *     analyzer.observeBlock(block.number, block.timestamp, uniqueSenders);
 *   // periodicamente:
 *   const clusters = analyzer.detectClusters();
 */
export class CooccurrenceAnalyzer {
  private readonly windowMs: number;
  private readonly maxObservations: number;
  private readonly minCooccurrences: number;
  private readonly minJaccard: number;

  private observations: BlockObservation[] = [];
  private senderCounts = new Map<string, number>();
  private pairCounts = new Map<string, number>(); // key = "addr_a|addr_b" sorted

  constructor(opts: CooccurrenceAnalyzerOpts = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxObservations = opts.maxObservations ?? DEFAULT_MAX_OBS;
    this.minCooccurrences = opts.minCooccurrences ?? DEFAULT_MIN_COOCC;
    this.minJaccard = opts.minJaccard ?? DEFAULT_MIN_JACCARD;
  }

  /**
   * Registra observation de bloco + senders.
   * Para cada par (i, j) de senders no bloco, incrementa counter de cooccurrence.
   */
  observeBlock(blockNumber: bigint, timestamp: number, senders: Address[]): void {
    // Dedup senders pra não inflar
    const unique = [...new Set(senders.map((s) => s.toLowerCase()))];
    if (unique.length === 0) return;

    this.observations.push({
      block_number: blockNumber,
      timestamp,
      senders: unique as Address[],
    });

    if (this.observations.length > this.maxObservations) {
      this._evictOldest();
    }

    // Increment singleton counts
    for (const s of unique) {
      this.senderCounts.set(s, (this.senderCounts.get(s) ?? 0) + 1);
    }

    // Increment pair counts (combinations sem repetição)
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i]!;
        const b = unique[j]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        this.pairCounts.set(key, (this.pairCounts.get(key) ?? 0) + 1);
      }
    }

    // Prune old observations
    this._pruneOld();
  }

  /**
   * Top N pairs mais correlacionados por Jaccard.
   */
  topLinks(limit = 20): CooccurrenceLink[] {
    const links: CooccurrenceLink[] = [];
    for (const [key, cooc] of this.pairCounts.entries()) {
      if (cooc < this.minCooccurrences) continue;
      const [a, b] = key.split('|') as [string, string];
      const totalA = this.senderCounts.get(a) ?? 0;
      const totalB = this.senderCounts.get(b) ?? 0;
      const union = totalA + totalB - cooc;
      const jaccard = union > 0 ? cooc / union : 0;
      const condBgivenA = totalA > 0 ? cooc / totalA : 0;

      links.push({
        sender_a: a as Address,
        sender_b: b as Address,
        cooccurrences: cooc,
        total_a: totalA,
        total_b: totalB,
        jaccard: Math.round(jaccard * 1000) / 1000,
        conditional_b_given_a: Math.round(condBgivenA * 1000) / 1000,
      });
    }
    return links
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, limit);
  }

  /**
   * Detecta clusters: componentes conexos no graph de links com jaccard >= minJaccard.
   * Implementação: union-find simples.
   */
  detectClusters(): CooccurrenceCluster[] {
    const strongLinks = this.topLinks(10_000).filter((l) => l.jaccard >= this.minJaccard);
    if (strongLinks.length === 0) return [];

    // Union-find
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let cur = x;
      while (parent.get(cur) !== cur) {
        const p = parent.get(cur)!;
        parent.set(cur, parent.get(p) ?? p);
        cur = parent.get(cur)!;
      }
      return cur;
    };
    const union = (x: string, y: string) => {
      const rx = find(x); const ry = find(y);
      if (rx !== ry) parent.set(rx, ry);
    };

    for (const l of strongLinks) {
      const a = l.sender_a.toLowerCase();
      const b = l.sender_b.toLowerCase();
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      union(a, b);
    }

    // Agrupa por root
    const groups = new Map<string, { members: string[]; jaccards: number[] }>();
    for (const node of parent.keys()) {
      const root = find(node);
      const g = groups.get(root) ?? { members: [], jaccards: [] };
      g.members.push(node);
      groups.set(root, g);
    }
    // Avg jaccard por cluster
    for (const l of strongLinks) {
      const root = find(l.sender_a.toLowerCase());
      const g = groups.get(root);
      if (g) g.jaccards.push(l.jaccard);
    }

    const out: CooccurrenceCluster[] = [];
    for (const g of groups.values()) {
      if (g.members.length < 2) continue;
      const avgJ = g.jaccards.length > 0
        ? g.jaccards.reduce((acc, v) => acc + v, 0) / g.jaccards.length
        : 0;
      const totalBlocks = g.members.reduce((acc, m) => acc + (this.senderCounts.get(m) ?? 0), 0);
      out.push({
        members: g.members as Address[],
        avg_jaccard: Math.round(avgJ * 1000) / 1000,
        total_blocks_seen: totalBlocks,
      });
    }
    return out.sort((a, b) => b.avg_jaccard - a.avg_jaccard);
  }

  /**
   * Snapshot serializável (Fase 5) — stats + clusters detectados.
   * Puro (sem fs): o caller persiste no ledger/JSON. Fácil de testar.
   */
  snapshot(maxClusters = 20): {
    stats: ReturnType<CooccurrenceAnalyzer['stats']>;
    clusters: CooccurrenceCluster[];
    updatedAt: number;
  } {
    return {
      stats: this.stats(),
      clusters: this.detectClusters().slice(0, maxClusters),
      updatedAt: Date.now(),
    };
  }

  /**
   * Stats agregados.
   */
  stats(): {
    total_observations: number;
    unique_senders: number;
    total_pairs_tracked: number;
    strong_links: number;
  } {
    const strong = [...this.pairCounts.values()].filter((v) => v >= this.minCooccurrences).length;
    return {
      total_observations: this.observations.length,
      unique_senders: this.senderCounts.size,
      total_pairs_tracked: this.pairCounts.size,
      strong_links: strong,
    };
  }

  // ─── Internal ───

  private _pruneOld(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.observations.length > 0 && (this.observations[0]?.timestamp ?? 0) < cutoff) {
      this._evictOldest();
    }
  }

  private _evictOldest(): void {
    const old = this.observations.shift();
    if (!old) return;
    // Decrement counters
    for (const s of old.senders) {
      const key = s.toLowerCase();
      const c = (this.senderCounts.get(key) ?? 1) - 1;
      if (c <= 0) this.senderCounts.delete(key);
      else this.senderCounts.set(key, c);
    }
    for (let i = 0; i < old.senders.length; i++) {
      for (let j = i + 1; j < old.senders.length; j++) {
        const a = old.senders[i]!.toLowerCase();
        const b = old.senders[j]!.toLowerCase();
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const c = (this.pairCounts.get(key) ?? 1) - 1;
        if (c <= 0) this.pairCounts.delete(key);
        else this.pairCounts.set(key, c);
      }
    }
  }
}
