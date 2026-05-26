/**
 * AtlasRelay — submete bundles privados via FastLane Atlas (Base + Polygon principalmente).
 *
 * Atlas usa um protocolo diferente do Flashbots — auction-based. Detalhes:
 *   https://docs.fastlane.xyz/atlas/protocol
 *
 * STATUS: PLACEHOLDER.
 * - O protocolo Atlas exige uma struct `UserOperation` + `SolverOperation[]` codificada,
 *   não é eth_sendBundle simples.
 * - Pra MVP, este wrapper RETORNA NÃO SUPORTADO. Quando ativarmos Atlas integration
 *   de verdade, substituir submit() pela call real.
 *
 * Por enquanto, em chains onde Atlas faria sentido (Base/Polygon), o relayRouter usa
 * Blocknative como fallback (que já tem MEV-Share-style endpoint genérico).
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
