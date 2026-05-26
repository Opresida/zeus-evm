/**
 * Gas Oracle — fornece pricing EIP-1559 correto pra Base/Arb/OP/L2s modernas.
 *
 * Por que precisamos:
 *   Base usa EIP-1559 desde sempre. Gas é decomposto em:
 *     baseFee     — definido pelo bloco, queimado (não vai pra ninguém)
 *     priorityFee — gorjeta pro sequencer/validator
 *
 *   maxFeePerGas         = teto total (baseFee + priorityFee combinados)
 *   maxPriorityFeePerGas = gorjeta máxima
 *
 *   Se usarmos `gasPrice` legado, viem auto-converte mas:
 *     - Em volume alto, tx pode ficar pendente
 *     - OR pagamos gas além do necessário (gorjeta excessiva)
 *
 * Estratégia ZEUS:
 *   - Lê `eth_feeHistory` (cache por blockNumber — 1 RPC por bloco, não por tx)
 *   - baseFee atual do último bloco
 *   - priorityFee = config (default 0.001 gwei em Base — sequencer Coinbase é gentil)
 *   - maxFeePerGas = baseFee * MULTIPLIER + priorityFee (margem pra subida)
 *
 * Em Base sem MEV-Boost, priorityFee baixo funciona (FCFS por timestamp).
 * Em chains com competição de bots, ajustar pra cima via config.
 */

import type { PublicClient } from 'viem';
import { parseGwei } from 'viem';

import type { LoggerLike } from '@zeus-evm/aave-discovery';

type AnyPublicClient = PublicClient<any, any>;

export interface GasFees {
  /** Teto absoluto pago por gas (baseFee + priorityFee combined). */
  maxFeePerGas: bigint;
  /** Gorjeta pro sequencer/validator. */
  maxPriorityFeePerGas: bigint;
  /** baseFee atual do bloco recente (informativo). */
  baseFeePerGas: bigint;
  /** Block number da última leitura (pra cache). */
  blockNumber: bigint;
}

export interface GasOracleOpts {
  /** Prioridade tip em gwei (default 0.001 = ultra-conservador pra Base). */
  priorityFeeGwei: number;
  /** Multiplier do baseFee pra calcular maxFee (default 2x). */
  maxFeeMultiplier: number;
  logger?: LoggerLike;
}

export class GasOracle {
  private priorityFeeWei: bigint;
  private maxFeeMultiplier: number;
  private logger: LoggerLike | undefined;

  // Cache por blockNumber — se mesmo bloco, retorna cached sem RPC
  private cached: GasFees | null = null;

  constructor(opts: GasOracleOpts) {
    this.priorityFeeWei = parseGwei(opts.priorityFeeGwei.toString());
    this.maxFeeMultiplier = opts.maxFeeMultiplier;
    this.logger = opts.logger;
  }

  /**
   * Retorna fees pra próxima tx. Cache por blockNumber — só faz RPC se bloco mudou.
   */
  async getFees(client: AnyPublicClient): Promise<GasFees> {
    try {
      const currentBlock = await client.getBlockNumber();

      // Cache hit: mesmo bloco já consultado
      if (this.cached && this.cached.blockNumber === currentBlock) {
        return this.cached;
      }

      // Lê fee history dos últimos 4 blocos pra ter baseFee robusto
      const feeHistory = await client.getFeeHistory({
        blockCount: 4,
        rewardPercentiles: [50],
      });

      // baseFee do bloco mais recente (último elemento)
      // feeHistory.baseFeePerGas tem N+1 elementos (incluindo "next block" estimate)
      const baseFees = feeHistory.baseFeePerGas;
      const baseFeePerGas = baseFees[baseFees.length - 1] ?? 0n;

      // maxFee = baseFee * multiplier + priorityFee
      // Multiplier conservador pra absorver spike de baseFee no bloco seguinte
      const multiplierBigInt = BigInt(Math.floor(this.maxFeeMultiplier * 100));
      const maxFeePerGas = (baseFeePerGas * multiplierBigInt) / 100n + this.priorityFeeWei;

      const fees: GasFees = {
        maxFeePerGas,
        maxPriorityFeePerGas: this.priorityFeeWei,
        baseFeePerGas,
        blockNumber: currentBlock,
      };

      this.cached = fees;
      return fees;
    } catch (err) {
      this.logger?.warn(
        { err: err instanceof Error ? err.message : err },
        'GasOracle: falha ao ler feeHistory — usando fallback conservador',
      );
      // Fallback: priorityFee + 1 gwei base (Base mainnet típico ~0.001-0.1 gwei)
      const fallback: GasFees = {
        maxFeePerGas: this.priorityFeeWei + parseGwei('1'),
        maxPriorityFeePerGas: this.priorityFeeWei,
        baseFeePerGas: parseGwei('1'),
        blockNumber: 0n,
      };
      return fallback;
    }
  }

  /** Reset do cache (útil em testes ou after long idle). */
  invalidateCache(): void {
    this.cached = null;
  }
}
