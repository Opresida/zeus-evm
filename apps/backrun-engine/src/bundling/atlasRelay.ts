/**
 * AtlasRelay — DEPRECATED 2026-05-29.
 *
 * ⚠️ A Chainlink ADQUIRIU o Atlas da FastLane em janeiro/2026 — agora é exclusivo
 * do Chainlink SVR (Smart Value Recovery), não é mais OFA permissionless pra searchers.
 *   Fontes: chainlinktoday.com/chainlink-acquires-fastlane-atlas (2026-01)
 *           crowdfundinsider.com/2026/01/258239-chainlink-acquires-atlas-by-fastlane
 *
 * NÃO usar mais. Arquivo mantido como contexto histórico — sai quando refizermos
 * o relayRouter pro Motor 3 (ver docs/MOTOR3_REFIT.md). Era placeholder de qualquer forma.
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

import type {
  BundleRelay,
  RelayConfig,
  SubmitBundleInput,
  SubmitBundleResult,
  RelayName,
} from './types';

// Atlas roda em Base (8453), Polygon (137), Sepolia, etc.
const ATLAS_SUPPORTED_CHAINS = new Set<number>([8453, 137, 84532]);

export class AtlasRelay implements BundleRelay {
  readonly name: RelayName = 'atlas';

  private readonly url: string | undefined;
  private readonly logger: LoggerLike | undefined;

  constructor(config: RelayConfig, logger?: LoggerLike) {
    this.url = config.atlasUrl;
    this.logger = logger;
  }

  supports(chainId: number): boolean {
    return ATLAS_SUPPORTED_CHAINS.has(chainId) && Boolean(this.url);
  }

  async submit(input: SubmitBundleInput): Promise<SubmitBundleResult> {
    // PLACEHOLDER: protocolo Atlas é diferente (UserOp + SolverOp), não eth_sendBundle.
    // Ver TODO no header. Por enquanto, no-op informativo.
    this.logger?.warn(
      { chainId: input.chainId, bundleId: input.bundleId },
      '🚧 AtlasRelay.submit: placeholder — protocolo Atlas precisa wrapper específico, fallback pra outro relay',
    );
    return {
      ok: false,
      relay: this.name,
      error: 'AtlasRelay placeholder — ativar quando integrar UserOp encoding',
    };
  }
}
