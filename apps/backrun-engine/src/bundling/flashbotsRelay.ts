/**
 * FlashbotsRelay — submete bundles privados via `eth_sendBundle` ao endpoint
 * Flashbots Protect (ou compatible).
 *
 * Compatibilidade: Flashbots oficial roda em Ethereum L1. Em L2s específicos (Arbitrum,
 * Optimism, Base), há endpoints separados ou outros relays (Atlas/Blocknative). O caller
 * configura `flashbotsUrl` por chain.
 *
 * Auth: Flashbots exige header `X-Flashbots-Signature` = `<address>:<signature>` onde a
 * signature é uma EIP-191 personal_sign do hash do payload feita pelo `flashbotsAuthKey`.
 * Esse signing key NÃO precisa ser o mesmo do bot — é só pra reputation tracking.
 *
 * Pra MVP, suportamos:
 *   - eth_sendBundle: enfileira bundle pra targetBlock+1
 *
 * NÃO implementamos ainda (TODOs):
 *   - flashbots_getBundleStats: ver se nosso bundle foi includes/simulated
 *   - eth_callBundle: simular o bundle sem submeter
 *   - mev_sendBundle: MEV-Share v2 (compartilhamento de hints)
 */

import { keccak256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { LoggerLike } from '@zeus-evm/aave-discovery';

import type {
  BundleRelay,
  RelayConfig,
  SubmitBundleInput,
  SubmitBundleResult,
  RelayName,
} from './types';

/**
 * Chains onde Flashbots Protect tem endpoint conhecido.
 * Mainnet (1), Sepolia (11155111). Adicionar conforme expansão.
 */
const FLASHBOTS_SUPPORTED_CHAINS = new Set<number>([1, 11155111]);

const DEFAULT_FLASHBOTS_URL = 'https://relay.flashbots.net';

export class FlashbotsRelay implements BundleRelay {
  readonly name: RelayName = 'flashbots';

  private readonly url: string;
  private readonly authKey: Hex | undefined;
  private readonly timeoutMs: number;
  private readonly logger: LoggerLike | undefined;

  constructor(config: RelayConfig, logger?: LoggerLike) {
    this.url = config.flashbotsUrl ?? DEFAULT_FLASHBOTS_URL;
    this.authKey = config.flashbotsAuthKey;
    this.timeoutMs = config.timeoutMs ?? 4_000;
    this.logger = logger;
  }

  supports(chainId: number): boolean {
    return FLASHBOTS_SUPPORTED_CHAINS.has(chainId);
  }

  async submit(input: SubmitBundleInput): Promise<SubmitBundleResult> {
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
          // minTimestamp / maxTimestamp opcionais — usados pra forçar inclusão dentro de janela.
          // Pra MVP, deixar undefined = "qualquer momento dentro do bloco alvo".
        },
      ],
    };

    const body = JSON.stringify(payload);

    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Flashbots signature header (opcional mas recomendado pra reputation)
    if (this.authKey) {
      try {
        const account = privateKeyToAccount(this.authKey);
        const messageHash = keccak256(toBytes(body));
        const signature = await account.signMessage({ message: { raw: messageHash } });
        headers['X-Flashbots-Signature'] = `${account.address}:${signature}`;
      } catch (err) {
        this.logger?.warn(
          { err: err instanceof Error ? err.message : err },
          'Flashbots: signing key inválida — submetendo sem signature header',
        );
      }
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body,
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
