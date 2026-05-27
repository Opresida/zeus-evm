/**
 * PauseDetector — Grupo B do bloqueio mainnet.
 *
 * Detecta se protocolo upstream está pausado ANTES de submeter tx. Se Aave/Compound
 * está em `paused()` state, qualquer liquidation submetida vai reverter queimando gas.
 *
 * Aave V3 (multi-chain — Base/Arb/OP/Polygon/Avalanche/Mainnet):
 *  - `Pool.paused()` — pausa global do protocolo (governance emergency)
 *  - `Pool.getReserveData(asset).configuration` — bits 56,57 (paused) + 58,59 (active)
 *    Cada asset pode ter pause individual (LP risk policy)
 *
 * Compound III (Base/Arb/Polygon/Mainnet; NÃO Avalanche):
 *  - `Comet.isAbsorbPaused()` — pausa de liquidations
 *  - `Comet.isSupplyPaused()`, `isWithdrawPaused()`, etc — granular per-action
 *
 * Multi-chain: ABIs idênticas em todas EVM chains. Endereços vêm de chain-config.
 *
 * Cache: pause state é stateful on-chain. Cacheado por (chain, address, block) com
 * TTL curto (3 blocos) — pausa muda raramente mas precisamos refresh recente.
 */

import type { Address, PublicClient } from 'viem';

type AnyPublicClient = PublicClient<any, any>;

export const AAVE_POOL_PAUSED_ABI = [
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getConfiguration',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'asset' }],
    outputs: [{
      type: 'tuple',
      components: [{ type: 'uint256', name: 'data' }],
    }],
  },
] as const;

export const COMET_PAUSED_ABI = [
  {
    type: 'function',
    name: 'isAbsorbPaused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isSupplyPaused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
] as const;

export interface PauseCheckResult {
  paused: boolean;
  /** Detalhe da causa do pause (ex: "pool global", "asset paused", "absorb paused"). */
  reason?: string;
  /** Endereço consultado. */
  protocol_address: Address;
  /** Bloco em que foi checado. */
  checked_at_block: bigint;
}

export interface PauseDetectorOpts {
  /** TTL de cache em blocos. Default 3. */
  cacheTtlBlocks?: number;
}

const DEFAULT_CACHE_TTL_BLOCKS = 3n;

// Aave V3 ReserveConfigurationMap bit layout (do Aave V3 docs):
// bit 56-57: reserved
// bit 58: paused
// bit 59-60: borrowing/stable enabled
// Pra detectar paused, lemos bit 58.
const AAVE_RESERVE_PAUSED_BIT = 60n;

/**
 * Detector stateful — caches pause states com TTL em blocos.
 */
export class PauseDetector {
  private readonly cacheTtlBlocks: bigint;
  private cache = new Map<string, { result: PauseCheckResult; block: bigint }>();

  constructor(
    private readonly client: AnyPublicClient,
    opts: PauseDetectorOpts = {},
  ) {
    this.cacheTtlBlocks = BigInt(opts.cacheTtlBlocks ?? DEFAULT_CACHE_TTL_BLOCKS);
  }

  /**
   * Check global pause do Aave Pool. Se paused=true, NENHUMA liquidation passa.
   */
  async checkAavePoolPause(poolAddress: Address): Promise<PauseCheckResult> {
    const block = await this.client.getBlockNumber();
    const cacheKey = `aave-global:${poolAddress.toLowerCase()}`;
    const cached = this._getCached(cacheKey, block);
    if (cached) return cached;

    try {
      const paused = (await this.client.readContract({
        address: poolAddress,
        abi: AAVE_POOL_PAUSED_ABI,
        functionName: 'paused',
      })) as boolean;

      const result: PauseCheckResult = {
        paused,
        reason: paused ? 'aave pool global pause' : undefined,
        protocol_address: poolAddress,
        checked_at_block: block,
      };
      this._setCached(cacheKey, result, block);
      return result;
    } catch (err) {
      // Fail-open: se RPC falhar, assume não pausado (caller decide)
      return {
        paused: false,
        reason: `RPC error: ${err instanceof Error ? err.message : 'unknown'}`,
        protocol_address: poolAddress,
        checked_at_block: block,
      };
    }
  }

  /**
   * Check pause por asset (Aave V3 reserve config bit 60).
   * Útil porque governance pode pausar 1 asset sem pausar o pool inteiro.
   */
  async checkAaveAssetPause(poolAddress: Address, asset: Address): Promise<PauseCheckResult> {
    const block = await this.client.getBlockNumber();
    const cacheKey = `aave-asset:${poolAddress.toLowerCase()}:${asset.toLowerCase()}`;
    const cached = this._getCached(cacheKey, block);
    if (cached) return cached;

    try {
      const config = (await this.client.readContract({
        address: poolAddress,
        abi: AAVE_POOL_PAUSED_ABI,
        functionName: 'getConfiguration',
        args: [asset],
      })) as { data: bigint };

      // bit 60 = paused flag (Aave V3 ReserveConfiguration spec)
      const pausedBit = (config.data >> AAVE_RESERVE_PAUSED_BIT) & 1n;
      const paused = pausedBit === 1n;

      const result: PauseCheckResult = {
        paused,
        reason: paused ? `aave asset ${asset} paused` : undefined,
        protocol_address: poolAddress,
        checked_at_block: block,
      };
      this._setCached(cacheKey, result, block);
      return result;
    } catch (err) {
      return {
        paused: false,
        reason: `RPC error: ${err instanceof Error ? err.message : 'unknown'}`,
        protocol_address: poolAddress,
        checked_at_block: block,
      };
    }
  }

  /**
   * Check pause de absorbs (liquidations) num Compound III Comet.
   */
  async checkCometAbsorbPause(cometAddress: Address): Promise<PauseCheckResult> {
    const block = await this.client.getBlockNumber();
    const cacheKey = `comet-absorb:${cometAddress.toLowerCase()}`;
    const cached = this._getCached(cacheKey, block);
    if (cached) return cached;

    try {
      const paused = (await this.client.readContract({
        address: cometAddress,
        abi: COMET_PAUSED_ABI,
        functionName: 'isAbsorbPaused',
      })) as boolean;

      const result: PauseCheckResult = {
        paused,
        reason: paused ? 'comet absorb paused' : undefined,
        protocol_address: cometAddress,
        checked_at_block: block,
      };
      this._setCached(cacheKey, result, block);
      return result;
    } catch (err) {
      return {
        paused: false,
        reason: `RPC error: ${err instanceof Error ? err.message : 'unknown'}`,
        protocol_address: cometAddress,
        checked_at_block: block,
      };
    }
  }

  /**
   * Aave V3: check global pool + ambos assets (debt + collateral) em paralelo.
   * Returna primeiro pause detectado, ou OK.
   */
  async checkAaveLiquidation(
    poolAddress: Address,
    debtAsset: Address,
    collateralAsset: Address,
  ): Promise<PauseCheckResult> {
    const [globalP, debtP, collatP] = await Promise.all([
      this.checkAavePoolPause(poolAddress),
      this.checkAaveAssetPause(poolAddress, debtAsset),
      this.checkAaveAssetPause(poolAddress, collateralAsset),
    ]);

    if (globalP.paused) return globalP;
    if (debtP.paused) return debtP;
    if (collatP.paused) return collatP;

    return {
      paused: false,
      protocol_address: poolAddress,
      checked_at_block: globalP.checked_at_block,
    };
  }

  /**
   * Invalida cache (uso em reorg events — flush full).
   */
  invalidateCache(): void {
    this.cache.clear();
  }

  // ─── Internal ───

  private _getCached(key: string, currentBlock: bigint): PauseCheckResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (currentBlock - entry.block > this.cacheTtlBlocks) return null;
    return entry.result;
  }

  private _setCached(key: string, result: PauseCheckResult, block: bigint): void {
    this.cache.set(key, { result, block });
    // Soft cap pra não vazar memória
    if (this.cache.size > 500) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }
}
