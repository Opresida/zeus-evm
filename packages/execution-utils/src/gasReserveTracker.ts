/**
 * Gas Reserve Tracker — monitora ETH balance da bot wallet + alerta quando baixo.
 *
 * Cenário sem isso: liquidation chega, bot tenta submeter tx, falha por "insufficient
 * funds for gas". Você não recebe alerta. Oportunidade perdida silenciosamente.
 * Em uma janela de 24h sem ETH, pode-se perder $50-500 de profit potencial.
 *
 * 2 thresholds:
 *   - WARN: alerta visível no log + Discord (não bloqueia)
 *   - CRITICAL: bloqueia dispatches (gate pre-dispatch) — evita tentar tx
 *     com gas insuficiente que vai falhar
 *
 * Update: leitura via `client.getBalance(account)` a cada tick.
 * Em DRY_RUN sem wallet, retorna sempre 'ok' (skip checks).
 *
 * Não persiste — estado vive em memória. Restart força nova leitura.
 */

import type { Address, PublicClient } from 'viem';
import { formatEther } from 'viem';

import type { LoggerLike } from '@zeus-evm/aave-discovery';

type AnyPublicClient = PublicClient<any, any>;

export type GasReserveStatus = 'ok' | 'warn' | 'critical' | 'unknown';

export interface GasReserveStats {
  status: GasReserveStatus;
  balanceWei: bigint;
  balanceEth: string;
  balanceUsd: number | null;
  warnThresholdEth: string;
  criticalThresholdEth: string;
  lastCheckedAt: number | null;
  account?: Address;
  blockDispatchOnCritical: boolean;
}

export interface GasReserveTrackerOpts {
  warnThresholdWei: bigint;
  criticalThresholdWei: bigint;
  blockDispatchOnCritical: boolean;
  ethUsdPrice: number;
  logger?: LoggerLike;
}

export class GasReserveTracker {
  private warnThreshold: bigint;
  private criticalThreshold: bigint;
  private blockDispatch: boolean;
  private ethUsdPrice: number;
  private logger: LoggerLike | undefined;

  // Estado interno — atualizado a cada check
  private lastStatus: GasReserveStatus = 'unknown';
  private lastBalance = 0n;
  private lastCheckedAt: number | null = null;
  private lastAccount: Address | undefined;

  // Anti-spam: só loga warn/critical uma vez por mudança de status (evita spam de logs)
  private alreadyAlerted: GasReserveStatus | null = null;

  constructor(opts: GasReserveTrackerOpts) {
    this.warnThreshold = opts.warnThresholdWei;
    this.criticalThreshold = opts.criticalThresholdWei;
    this.blockDispatch = opts.blockDispatchOnCritical;
    this.ethUsdPrice = opts.ethUsdPrice;
    this.logger = opts.logger;
  }

  /**
   * Verifica balance on-chain + atualiza estado interno.
   * Sem wallet (DRY_RUN), pula e mantém status 'unknown'.
   */
  async check(client: AnyPublicClient, account?: Address): Promise<GasReserveStatus> {
    if (!account) {
      this.lastStatus = 'unknown';
      return 'unknown';
    }

    try {
      const balance = await client.getBalance({ address: account });
      this.lastBalance = balance;
      this.lastCheckedAt = Date.now();
      this.lastAccount = account;

      let status: GasReserveStatus;
      if (balance <= this.criticalThreshold) {
        status = 'critical';
      } else if (balance <= this.warnThreshold) {
        status = 'warn';
      } else {
        status = 'ok';
      }

      // Log de mudança de status (anti-spam: só alerta uma vez por status novo)
      if (status !== this.lastStatus && status !== 'ok') {
        const balanceEth = formatEther(balance);
        const balanceUsd = (Number(balance) / 1e18) * this.ethUsdPrice;
        if (status === 'critical') {
          this.logger?.fatal(
            {
              account,
              balanceEth,
              balanceUsd: balanceUsd.toFixed(2),
              criticalThresholdEth: formatEther(this.criticalThreshold),
              blockDispatch: this.blockDispatch,
            },
            `🚨 GAS RESERVE CRITICAL — wallet ${account} tem apenas ${balanceEth} ETH ($${balanceUsd.toFixed(2)})${this.blockDispatch ? ' — dispatches bloqueados' : ''}`,
          );
        } else if (status === 'warn') {
          this.logger?.warn(
            {
              account,
              balanceEth,
              balanceUsd: balanceUsd.toFixed(2),
              warnThresholdEth: formatEther(this.warnThreshold),
            },
            `⚠️ Gas reserve baixo — wallet ${account} tem ${balanceEth} ETH ($${balanceUsd.toFixed(2)})`,
          );
        }
        this.alreadyAlerted = status;
      } else if (status === 'ok' && this.alreadyAlerted !== null) {
        // Recuperou — alerta de retomada
        this.logger?.info(
          {
            account,
            balanceEth: formatEther(balance),
          },
          `✅ Gas reserve OK — recuperado de ${this.alreadyAlerted}`,
        );
        this.alreadyAlerted = null;
      }

      this.lastStatus = status;
      return status;
    } catch (err) {
      this.logger?.error(
        { err: err instanceof Error ? err.message : err, account },
        'Falha ao ler balance — mantendo status anterior',
      );
      return this.lastStatus;
    }
  }

  /** True se dispatches devem ser bloqueados (status crítico + flag ativada). */
  shouldBlockDispatch(): boolean {
    return this.blockDispatch && this.lastStatus === 'critical';
  }

  /** Status atual sem fazer nova chamada RPC. */
  currentStatus(): GasReserveStatus {
    return this.lastStatus;
  }

  stats(): GasReserveStats {
    return {
      status: this.lastStatus,
      balanceWei: this.lastBalance,
      balanceEth: formatEther(this.lastBalance),
      balanceUsd: this.lastCheckedAt !== null ? (Number(this.lastBalance) / 1e18) * this.ethUsdPrice : null,
      warnThresholdEth: formatEther(this.warnThreshold),
      criticalThresholdEth: formatEther(this.criticalThreshold),
      lastCheckedAt: this.lastCheckedAt,
      account: this.lastAccount,
      blockDispatchOnCritical: this.blockDispatch,
    };
  }
}
