/**
 * RelayRouter — multiplexa bundle submission pra TODOS os relays suportados em paralelo.
 *
 * Estratégia: pra cada bundle, submetemos simultaneamente em N relays disponíveis.
 * O primeiro a confirmar inclusion (= o bundle hash nos eventos do bloco) ganha.
 * Custo: $0 pra bundles perdidos (bundles privados não custam gas).
 *
 * Logging: cada submit gera resultado tipado (ok/error + relay name) — útil pra
 * stats de win rate por relay (qual está te incluindo mais).
 *
 * Fail behavior: se NENHUM relay suporta a chainId OU todos retornam erro, retorna
 * `{ ok: false, errors: [...] }`. Caller decide se faz fallback (ex: tx pública).
 */

import type { LoggerLike } from '@zeus-evm/aave-discovery';

import type {
  BundleRelay,
  RelayConfig,
  SubmitBundleInput,
  SubmitBundleResult,
} from './types';
import { FlashbotsRelay } from './flashbotsRelay';
import { AtlasRelay } from './atlasRelay';
import { BlocknativeRelay } from './blocknativeRelay';

export interface RelayRouterOpts {
  config: RelayConfig;
  /** Override custom — caller pode passar relays mockados (testes). */
  relays?: BundleRelay[];
  logger?: LoggerLike;
}

export interface RouterSubmitResult {
  /** True se ao menos 1 relay aceitou o bundle. */
  ok: boolean;
  /** Resultados individuais por relay (sucesso ou erro). */
  results: SubmitBundleResult[];
  /** Bundle hash da primeira submissão bem-sucedida (pra correlação). */
  firstBundleHash?: string;
  elapsedMs: number;
}

export class RelayRouter {
  private readonly relays: BundleRelay[];
  private readonly logger: LoggerLike | undefined;

  constructor(opts: RelayRouterOpts) {
    this.logger = opts.logger;
    if (opts.relays) {
      this.relays = opts.relays;
    } else {
      // Default: instanciar todos relays oficiais com o config compartilhado
      this.relays = [
        new FlashbotsRelay(opts.config, opts.logger),
        new AtlasRelay(opts.config, opts.logger),
        new BlocknativeRelay(opts.config, opts.logger),
      ];
    }
  }

  /**
   * Submete em paralelo pra todos relays que suportam a chainId.
   */
  async submit(input: SubmitBundleInput): Promise<RouterSubmitResult> {
    const start = Date.now();
    const eligible = this.relays.filter((r) => r.supports(input.chainId));

    if (eligible.length === 0) {
      this.logger?.warn(
        { chainId: input.chainId, relays: this.relays.map((r) => r.name) },
        '⚠️ RelayRouter: nenhum relay suporta esta chainId',
      );
      return {
        ok: false,
        results: [],
        elapsedMs: Date.now() - start,
      };
    }

    this.logger?.debug(
      {
        chainId: input.chainId,
        targetBlock: input.targetBlockNumber.toString(),
        eligibleRelays: eligible.map((r) => r.name),
      },
      `📤 RelayRouter: submetendo bundle em ${eligible.length} relay(s)`,
    );

    const settled = await Promise.allSettled(eligible.map((r) => r.submit(input)));

    const results: SubmitBundleResult[] = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : { ok: false, relay: eligible[i]!.name, error: s.reason?.message ?? 'rejected' },
    );

    const successes = results.filter((r): r is Extract<SubmitBundleResult, { ok: true }> => r.ok);
    const firstBundleHash = successes[0]?.bundleHash;

    if (successes.length > 0) {
      this.logger?.info(
        {
          relaysOk: successes.map((s) => s.relay),
          relaysFail: results.filter((r) => !r.ok).map((r) => r.relay),
          firstBundleHash,
        },
        `✅ Bundle aceito por ${successes.length}/${eligible.length} relay(s)`,
      );
    } else {
      this.logger?.warn(
        {
          errors: results.map((r) => (!r.ok ? `${r.relay}: ${r.error}` : '')),
        },
        '❌ Bundle rejeitado por TODOS os relays',
      );
    }

    return {
      ok: successes.length > 0,
      results,
      firstBundleHash,
      elapsedMs: Date.now() - start,
    };
  }

  /** Lista relays registrados (pra log/debug). */
  registeredRelays(): string[] {
    return this.relays.map((r) => r.name);
  }
}
