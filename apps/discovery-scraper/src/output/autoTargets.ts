/**
 * Auto-targets writer — converte top candidates do scraper em TargetPair[] persistidos.
 *
 * Output: `apps/backrun-engine/auto-targets/<chain>.json` por chain.
 * Esse arquivo é carregado pelo backrun-engine no boot via `getTargetPairsForChain`,
 * que mescla com a lista hardcoded.
 *
 * Persistence policy (anti-flicker):
 *   - Candidate precisa aparecer em ≥2 cycles consecutivos pra ENTRAR no auto-json
 *   - Candidate fica no auto-json por até 3 cycles depois de sumir do top (grace period)
 *   - Se sumir por >3 cycles, é removido
 *
 * Threshold de score:
 *   - Score mínimo pra ser elegível: 60 (configurable via SCRAPER_MIN_AUTO_SCORE)
 *
 * Estado de cycles persistido em `state/auto-targets-tracking.json`:
 *   { "<chainId>": { "<pairId>": { firstSeen, lastSeen, cyclesSeenInARow, cyclesMissingInARow } } }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { Address } from 'viem';
import type { RankedCandidate } from './types';

/** Estrutura idêntica à TargetPair de `@zeus-evm/chain-config`, copiada pra evitar import circular. */
export interface AutoTargetPair {
  id: string;
  tokenA: Address;
  tokenB: Address;
  decimalsA: number;
  decimalsB: number;
  category: 'stable-stable' | 'lst-volatile' | 'volatile-stable' | 'volatile-volatile';
  estimatedUsdValueA: number;
  estimatedUsdValueB: number;
  uniswapV3FeeTiers: readonly number[];
  aerodromeStable: boolean;
  aerodromeVolatile: boolean;
  /** Metadata extra do scraper — não usado pelo backrun, apenas auditável. */
  scraperMeta: {
    score: number;
    fragmentationRatio: number;
    totalTvlUsd: number;
    totalVolumeUsd24h: number;
    firstSeenAt: string;
    lastSeenAt: string;
    cyclesSeenInARow: number;
    addedFromScraper: true;
  };
}

interface TrackingEntry {
  firstSeenAt: string;
  lastSeenAt: string;
  cyclesSeenInARow: number;
  cyclesMissingInARow: number;
}

interface TrackingState {
  version: 1;
  /** Por chainId → pairId → tracking */
  entries: Record<string, Record<string, TrackingEntry>>;
}

const DEFAULT_TRACKING: TrackingState = { version: 1, entries: {} };

/** Score mínimo absoluto pra candidate ENTRAR no auto-json (gate de qualidade). */
const DEFAULT_MIN_AUTO_SCORE = 50;
/** Score acima do qual promoção é IMEDIATA (1 cycle). Alta confiança. */
const HIGH_CONFIDENCE_SCORE = 65;
/** Quantos cycles consecutivos pra mid-tier (score 50-65) promover. */
const MID_TIER_CYCLES_TO_PROMOTE = 2;
/** Quantos cycles sem ver antes de REMOVER do auto-json (grace period). */
const MAX_CYCLES_MISSING = 3;

export interface AutoTargetsOpts {
  /** Dir do backrun-engine onde escrever <chain>.json. Default: apps/backrun-engine/auto-targets/ */
  outputDir: string;
  /** Path do tracking state JSON. */
  trackingStatePath: string;
  /** Score mínimo pra elegibilidade (default 60). */
  minAutoScore?: number;
  logger?: LoggerLike;
}

export class AutoTargetsWriter {
  private tracking: TrackingState = DEFAULT_TRACKING;
  private readonly outputDir: string;
  private readonly trackingStatePath: string;
  private readonly minAutoScore: number;
  private readonly logger: LoggerLike | undefined;

  constructor(opts: AutoTargetsOpts) {
    this.outputDir = opts.outputDir;
    this.trackingStatePath = opts.trackingStatePath;
    this.minAutoScore = opts.minAutoScore ?? DEFAULT_MIN_AUTO_SCORE;
    this.logger = opts.logger;
    this.loadTracking();
  }

  private loadTracking(): void {
    if (!existsSync(this.trackingStatePath)) {
      const dir = dirname(this.trackingStatePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      return;
    }
    try {
      const raw = readFileSync(this.trackingStatePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<TrackingState>;
      if (parsed.version === 1 && parsed.entries) {
        this.tracking = parsed as TrackingState;
      }
    } catch {
      this.logger?.warn({}, 'Tracking state corrompido — começando do zero');
    }
  }

  private saveTracking(): void {
    try {
      writeFileSync(this.trackingStatePath, JSON.stringify(this.tracking, null, 2));
    } catch (err) {
      this.logger?.warn({ err: err instanceof Error ? err.message : err }, 'Falha ao persistir tracking');
    }
  }

  /**
   * Processa candidates de UMA chain. Atualiza tracking + escreve auto-targets/<chain>.json.
   *
   * Política de promoção (refinada F3 round 2):
   *   - Score ≥ HIGH_CONFIDENCE_SCORE (65): promoção IMEDIATA (1 cycle)
   *   - Score em [50, 65): precisa MID_TIER_CYCLES_TO_PROMOTE (2) cycles
   *   - Score < 50: NÃO promove
   *
   * Grace period (MAX_CYCLES_MISSING = 3): par fica no auto-json por 3 cycles
   * após sumir do top — evita flicker em mercado oscilante.
   */
  processChain(chainId: number, chainGeckoNetwork: string, candidates: RankedCandidate[]): {
    promoted: AutoTargetPair[];
    newPromotions: string[];
    removed: string[];
  } {
    const now = new Date().toISOString();
    const chainKey = String(chainId);
    if (!this.tracking.entries[chainKey]) this.tracking.entries[chainKey] = {};
    const chainTracking = this.tracking.entries[chainKey]!;

    // Mapa pairId → score (pra decidir threshold de cycles)
    const seenThisCycle = new Map<string, number>();
    for (const c of candidates) {
      if (c.score >= this.minAutoScore) seenThisCycle.set(c.pairId, c.score);
    }

    // Atualiza tracking + detecta novos promovidos
    const newPromotions: string[] = [];
    for (const [pairId, score] of seenThisCycle) {
      const cyclesNeeded = score >= HIGH_CONFIDENCE_SCORE ? 1 : MID_TIER_CYCLES_TO_PROMOTE;
      const entry = chainTracking[pairId];

      if (!entry) {
        chainTracking[pairId] = {
          firstSeenAt: now,
          lastSeenAt: now,
          cyclesSeenInARow: 1,
          cyclesMissingInARow: 0,
        };
        // Alta confiança: promove imediatamente (1 cycle basta)
        if (cyclesNeeded === 1) newPromotions.push(pairId);
      } else {
        const wasPromoted = entry.cyclesSeenInARow >= cyclesNeeded;
        entry.lastSeenAt = now;
        entry.cyclesSeenInARow += 1;
        entry.cyclesMissingInARow = 0;
        if (!wasPromoted && entry.cyclesSeenInARow >= cyclesNeeded) {
          newPromotions.push(pairId);
        }
      }
    }

    // Decrementa cycles pra pares que não foram vistos
    const removed: string[] = [];
    for (const [pairId, entry] of Object.entries(chainTracking)) {
      if (seenThisCycle.has(pairId)) continue;
      entry.cyclesMissingInARow += 1;
      entry.cyclesSeenInARow = 0;
      if (entry.cyclesMissingInARow > MAX_CYCLES_MISSING) {
        delete chainTracking[pairId];
        removed.push(pairId);
      }
    }

    // Pares que entram no auto-json: stable enough OU em grace period
    const promotedPairIds = new Set<string>();
    for (const [pairId, entry] of Object.entries(chainTracking)) {
      const currentScore = seenThisCycle.get(pairId);
      const cyclesNeededForThis = currentScore !== undefined && currentScore >= HIGH_CONFIDENCE_SCORE
        ? 1
        : MID_TIER_CYCLES_TO_PROMOTE;
      const stableEnough = entry.cyclesSeenInARow >= cyclesNeededForThis;
      const inGracePeriod = entry.cyclesMissingInARow > 0 && entry.cyclesMissingInARow <= MAX_CYCLES_MISSING;
      if (stableEnough || inGracePeriod) promotedPairIds.add(pairId);
    }

    const promoted: AutoTargetPair[] = candidates
      .filter((c) => promotedPairIds.has(c.pairId))
      .map((c) => this.rankedToTargetPair(c, chainTracking[c.pairId]!));

    this.writeChainFile(chainGeckoNetwork, promoted);
    this.saveTracking();

    this.logger?.info(
      {
        chainId,
        promoted: promoted.length,
        newPromotions: newPromotions.length,
        removed: removed.length,
      },
      `📝 Auto-targets ${chainGeckoNetwork}: ${promoted.length} promovidos (${newPromotions.length} novos, ${removed.length} removidos)`,
    );

    return { promoted, newPromotions, removed };
  }

  private rankedToTargetPair(c: RankedCandidate, tracking: TrackingEntry): AutoTargetPair {
    // category heurística pelo symbol (refinamento futuro: olhar listing CoinGecko coin type)
    const stableSet = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'EURC', 'GHO']);
    const lstSet = new Set(['CBETH', 'WSTETH', 'WEETH', 'EZETH', 'RSETH', 'STETH', 'RETH']);
    const baseUpper = c.baseTokenSymbol.toUpperCase();
    const quoteUpper = c.quoteTokenSymbol.toUpperCase();

    let category: AutoTargetPair['category'] = 'volatile-volatile';
    if (stableSet.has(baseUpper) && stableSet.has(quoteUpper)) category = 'stable-stable';
    else if (stableSet.has(baseUpper) || stableSet.has(quoteUpper)) category = 'volatile-stable';
    else if (lstSet.has(baseUpper) || lstSet.has(quoteUpper)) category = 'lst-volatile';

    // Fee tiers: extrai de c.pools[].feeTier — UniV3 retorna "0.05%" etc.
    const feeTiersSet = new Set<number>();
    for (const pool of c.pools) {
      if (!pool.feeTier) continue;
      if (pool.feeTier === '0.01%') feeTiersSet.add(100);
      else if (pool.feeTier === '0.05%') feeTiersSet.add(500);
      else if (pool.feeTier === '0.3%') feeTiersSet.add(3000);
      else if (pool.feeTier === '1%') feeTiersSet.add(10000);
    }
    const feeTiers = feeTiersSet.size > 0 ? Array.from(feeTiersSet).sort((a, b) => a - b) : [500];

    // Estimativa USD value — usa volume ponderado pra inferir preço médio
    // Pra MVP: deixa o backrun-engine fazer quote real (estimatedUsd só é hint)
    const totalVol = c.totalVolumeUsd24h || 1;
    const baseUsdEstimate = baseUpper === 'WETH' || baseUpper === 'ETH' ? 2100
      : stableSet.has(baseUpper) ? 1
      : totalVol / 1_000_000; // hint grosseiro
    const quoteUsdEstimate = quoteUpper === 'WETH' || quoteUpper === 'ETH' ? 2100
      : stableSet.has(quoteUpper) ? 1
      : totalVol / 1_000_000;

    // Detecta se um dos pools é Aerodrome/Velodrome
    const hasAeroVelo = c.pools.some((p) =>
      p.dexId.toLowerCase().includes('aerodrome') || p.dexId.toLowerCase().includes('velodrome'),
    );

    return {
      id: c.pairId,
      tokenA: c.baseTokenAddress as Address,
      tokenB: c.quoteTokenAddress as Address,
      decimalsA: 18, // hint — backrun-engine resolve real on-chain quando precisar
      decimalsB: stableSet.has(quoteUpper) && quoteUpper === 'USDC' ? 6 : 18,
      category,
      estimatedUsdValueA: baseUsdEstimate,
      estimatedUsdValueB: quoteUsdEstimate,
      uniswapV3FeeTiers: feeTiers,
      aerodromeStable: false,
      aerodromeVolatile: hasAeroVelo,
      scraperMeta: {
        score: c.score,
        fragmentationRatio: c.breakdown.fragmentationRatio,
        totalTvlUsd: c.totalTvlUsd,
        totalVolumeUsd24h: c.totalVolumeUsd24h,
        firstSeenAt: tracking.firstSeenAt,
        lastSeenAt: tracking.lastSeenAt,
        cyclesSeenInARow: tracking.cyclesSeenInARow,
        addedFromScraper: true,
      },
    };
  }

  private writeChainFile(chainGeckoNetwork: string, targets: AutoTargetPair[]): void {
    if (!existsSync(this.outputDir)) mkdirSync(this.outputDir, { recursive: true });
    const filePath = resolve(this.outputDir, `${chainGeckoNetwork}.json`);
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      chainGeckoNetwork,
      targets,
    };
    writeFileSync(filePath, JSON.stringify(payload, null, 2));
  }

  stats(): { totalTracked: number; totalPromoted: number } {
    let totalTracked = 0;
    let totalPromoted = 0;
    for (const chainEntries of Object.values(this.tracking.entries)) {
      totalTracked += Object.keys(chainEntries).length;
      for (const e of Object.values(chainEntries)) {
        // Stable enough = visto em ≥1 cycle (vale tanto pra high-conf 1 cycle quanto mid-tier 2)
        if (e.cyclesSeenInARow >= 1) totalPromoted++;
      }
    }
    return { totalTracked, totalPromoted };
  }
}
