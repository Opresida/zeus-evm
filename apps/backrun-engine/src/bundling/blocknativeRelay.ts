/**
 * BlocknativeRelay — DEPRECATED 2026-05-29.
 *
 * ⚠️ A Blocknative Corporation CESSOU OPERAÇÕES em junho/2025:
 *   - Mempool Archive descontinuado em 01/03/2025
 *   - APIs + Gas Network desligadas até 19/06/2025
 *   - Equipe foi pra Deloitte
 *   Fontes: crypto-economy.com/blocknative-winds-down-core-services (2025)
 *           docs.blocknative.com/data-archive/mempool-archive
 *
 * NÃO usar mais. O arquivo é mantido só por contexto histórico — quando o relayRouter
 * for refeito pro Motor 3 (ver docs/MOTOR3_REFIT.md), este adapter sai. Por enquanto
 * o adapter ainda existe mas o BLOCKNATIVE_RELAY_URL no .env não vai resolver.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

import type {
  BundleRelay,
  RelayConfig,
  SubmitBundleInput,
  SubmitBundleResult,
  RelayName,
} from './types';

// Chains onde Blocknative MEV roda. Atualizar via docs oficiais conforme expansão.
const BLOCKNATIVE_SUPPORTED_CHAINS = new Set<number>([1, 137, 42161, 10, 8453]);

export class BlocknativeRelay implements BundleRelay {
  readonly name: RelayName = 'blocknative';

  private readonly url: string | undefined;
  private readonly timeoutMs: number;
  private readonly logger: LoggerLike | undefined;

  constructor(config: RelayConfig, logger?: LoggerLike) {
    this.url = config.blocknativeUrl;
    this.timeoutMs = config.timeoutMs ?? 4_000;
    this.logger = logger;
  }

  supports(chainId: number): boolean {
    return BLOCKNATIVE_SUPPORTED_CHAINS.has(chainId) && Boolean(this.url);
  }

  async submit(input: SubmitBundleInput): Promise<SubmitBundleResult> {
    if (!this.url) {
      return { ok: false, relay: this.name, error: 'BLOCKNATIVE_RELAY_URL não configurado' };
    }
    if (!this.supports(input.chainId)) {
      return { ok: false, relay: this.name, error: `chainId ${input.chainId} não suportado` };
    }

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_sendBundle',
      params: [
        {
          txs: [input.signedTx],
          blockNumber: `0x${input.targetBlockNumber.toString(16)}`,
        },
      ],
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ok: false,
          relay: this.name,
          error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        };
      }

      const json = (await res.json()) as { result?: { bundleHash?: string }; error?: { message?: string } };
      if (json.error) {
        return {
          ok: false,
          relay: this.name,
          error: json.error.message ?? 'unknown JSON-RPC error',
        };
      }

      const bundleHash = json.result?.bundleHash ?? 'unknown';
      return {
        ok: true,
        relay: this.name,
        bundleHash,
        submittedAt: Date.now(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, relay: this.name, error: msg.slice(0, 200) };
    }
  }
}
