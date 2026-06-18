/**
 * BlockHistoryScanner — Item 5 F2 do checklist.
 *
 * Background job READ-ONLY. Scan blocos Base mainnet conforme produzidos,
 * filtra txs que tocam contratos alvo (Aave/Compound/Morpho/UniV3/Aerodrome),
 * extrai sender + gas + protocolo, atualiza SenderRegistry.
 *
 * **Por que importa:** popula registry mesmo SEM o bot dispatcher rodar.
 * Em 1 semana de coleta passiva → baseline robusto dos bots mais ativos.
 * Em 1 mês → perfil completo do landscape MEV em Base.
 *
 * Custo: ~1 RPC call por bloco (~2s = 43.200 calls/dia em Base). Free tier OK.
 *
 * Não faz tx submission — 100% leitura.
 */

import type { Address, PublicClient } from 'viem';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

import { SenderRegistry } from './senderRegistry';
import type { CompetitorProfile } from './senderSchema';
import type { CooccurrenceAnalyzer } from './cooccurrenceAnalyzer';
import type { BuilderAttributionTracker } from './builderAttributionTracker';

type AnyPublicClient = PublicClient<any, any>;

/**
 * Set de endereços-alvo (lowercase) — contratos que indicam relevância.
 * Sender tocando algum desses entra no registry.
 */
export interface ScannerTargets {
  aave_v3_pool?: Address;
  compound_comets?: Address[];      // cUSDCv3, cWETHv3, etc
  morpho_blue?: Address;
  uniswap_v3_routers?: Address[];   // SwapRouter02 + UniversalRouter
  aerodrome_router?: Address;
}

export interface BlockHistoryScannerOpts {
  client: AnyPublicClient;
  registry: SenderRegistry;
  targets: ScannerTargets;
  /** Polling interval em ms. Default 2000 (~1 bloco Base). */
  pollIntervalMs?: number;
  /** Salva snapshot a cada N blocos processados. Default 100. */
  snapshotEveryNBlocks?: number;
  /**
   * Opcional (Fase 5): analisador de co-ocorrência (detecção de sybil). Recebe os senders
   * RELEVANTES (que tocaram alvos) por bloco — quem aparece junto repetidamente = mesma entidade.
   */
  cooccurrence?: CooccurrenceAnalyzer;
  /**
   * Opcional (Fase 5): atribuição por builder/miner. Recebe o `block.miner` + os `from` das txs.
   * Na Base (sequencer único) é menos rico, mas mantém o sinal pra multi-chain futuro.
   */
  builderAttribution?: BuilderAttributionTracker;
  logger?: LoggerLike;
}

export interface ScannerStats {
  blocks_processed: number;
  txs_observed: number;
  txs_matched_targets: number;
  unique_senders: number;
  last_block_processed: bigint | null;
  errors: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_SNAPSHOT_EVERY = 100;

export class BlockHistoryScanner {
  private readonly client: AnyPublicClient;
  private readonly registry: SenderRegistry;
  private readonly targets: Set<string>;
  private readonly pollIntervalMs: number;
  private readonly snapshotEvery: number;
  private readonly cooccurrence: CooccurrenceAnalyzer | undefined;
  private readonly builderAttribution: BuilderAttributionTracker | undefined;
  private readonly logger: LoggerLike | undefined;

  /** Reverse mapping endereço → protocolo (pra atribuir corretamente). */
  private readonly protocolByAddress = new Map<string, keyof CompetitorProfile['protocols']>();

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastProcessedBlock: bigint | null = null;
  private stats: ScannerStats;

  constructor(opts: BlockHistoryScannerOpts) {
    this.client = opts.client;
    this.registry = opts.registry;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.snapshotEvery = opts.snapshotEveryNBlocks ?? DEFAULT_SNAPSHOT_EVERY;
    this.cooccurrence = opts.cooccurrence;
    this.builderAttribution = opts.builderAttribution;
    this.logger = opts.logger;

    // Build target set + reverse map
    this.targets = new Set<string>();
    const addTarget = (addr: Address | undefined, proto: keyof CompetitorProfile['protocols']) => {
      if (!addr) return;
      const lower = addr.toLowerCase();
      this.targets.add(lower);
      this.protocolByAddress.set(lower, proto);
    };
    addTarget(opts.targets.aave_v3_pool, 'aave_v3');
    addTarget(opts.targets.morpho_blue, 'morpho_blue');
    addTarget(opts.targets.aerodrome_router, 'aerodrome');
    if (opts.targets.compound_comets) {
      for (const c of opts.targets.compound_comets) addTarget(c, 'compound_v3');
    }
    if (opts.targets.uniswap_v3_routers) {
      for (const r of opts.targets.uniswap_v3_routers) addTarget(r, 'uniswap_v3');
    }

    this.stats = {
      blocks_processed: 0,
      txs_observed: 0,
      txs_matched_targets: 0,
      unique_senders: 0,
      last_block_processed: null,
      errors: 0,
    };
  }

  /**
   * Inicia scanner. Idempotente.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.logger?.info(
      {
        targets: Array.from(this.targets).slice(0, 5),
        totalTargets: this.targets.size,
        pollIntervalMs: this.pollIntervalMs,
      },
      '🔭 BlockHistoryScanner iniciado',
    );

    void this._pollOnce();
    this.timer = setInterval(() => {
      void this._pollOnce();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  /**
   * Para scanner + salva snapshot final.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.registry.saveSnapshot();
  }

  getStats(): ScannerStats {
    return { ...this.stats, unique_senders: this.registry.stats().total_profiles };
  }

  // ─── Internal ───

  private async _pollOnce(): Promise<void> {
    if (!this.running) return;
    try {
      const latest = await this.client.getBlockNumber();
      if (this.lastProcessedBlock === null) {
        // Primeira execução — começa do bloco atual
        this.lastProcessedBlock = latest;
        return;
      }
      if (latest <= this.lastProcessedBlock) return;

      // Process até `latest` mas com cap pra não sobrecarregar (max 5 blocos por poll)
      const startBlock = this.lastProcessedBlock + 1n;
      const endBlock = latest > startBlock + 4n ? startBlock + 4n : latest;

      for (let b = startBlock; b <= endBlock; b++) {
        await this._processBlock(b);
        this.lastProcessedBlock = b;
        this.stats.blocks_processed++;

        // Snapshot periódico
        if (this.stats.blocks_processed % this.snapshotEvery === 0) {
          this.registry.saveSnapshot();
        }
      }

      this.stats.last_block_processed = endBlock;
    } catch (err) {
      this.stats.errors++;
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'BlockHistoryScanner: erro no poll',
      );
    }
  }

  private async _processBlock(blockNumber: bigint): Promise<void> {
    const block = await this.client.getBlock({
      blockNumber,
      includeTransactions: true,
    });

    if (!block.transactions) return;

    const timestamp = Number(block.timestamp) * 1000;
    const d = new Date(timestamp);
    const hour_utc = d.getUTCHours();
    const weekday = d.getUTCDay();

    // Senders RELEVANTES (tocaram alvos) + TODOS os from — pros analisadores da Fase 5.
    const matchedSenders: Address[] = [];
    const allFroms: Address[] = [];

    for (const tx of block.transactions) {
      // tx pode ser hash string ou objeto completo (depende do RPC)
      if (typeof tx === 'string') continue;
      this.stats.txs_observed++;
      if (tx.from) allFroms.push(tx.from as Address);

      const to = tx.to?.toLowerCase();
      if (!to || !this.targets.has(to)) continue;

      this.stats.txs_matched_targets++;
      const protocol = this.protocolByAddress.get(to);
      if (!protocol) continue;

      // Extrai gas info
      const priorityFeeGwei = tx.maxPriorityFeePerGas
        ? Number(tx.maxPriorityFeePerGas) / 1e9
        : tx.gasPrice
          ? Number(tx.gasPrice) / 1e9
          : undefined;

      this.registry.observe({
        sender: tx.from as Address,
        protocol,
        priority_fee_gwei: priorityFeeGwei,
        hour_utc,
        weekday,
        timestamp,
      });
      if (tx.from) matchedSenders.push(tx.from as Address);
    }

    // Fase 5 — alimenta os analisadores (opcionais). Co-ocorrência só faz sentido com 2+ senders.
    if (this.cooccurrence && matchedSenders.length >= 2) {
      this.cooccurrence.observeBlock(blockNumber, timestamp, matchedSenders);
    }
    if (this.builderAttribution && block.miner) {
      this.builderAttribution.observeBlock(block.miner as Address, allFroms);
    }
  }
}
