/**
 * BribeCalculator — calcula `BribeConfig` dinamicamente por oportunidade.
 *
 * Princípio: bundle privado perdido = $0 perdido (nem submete a tx pública).
 * Logo a estratégia ótima é:
 *   - Profit alto + competição alta → bid agressivo
 *   - Profit baixo → SKIP (não vale brigar)
 *
 * Tabela escalonada (do plano técnico):
 *   - profit > $50, normal           → 30% bribe + min $0.50
 *   - profit > $50, elevated         → 50-60% bribe + min $1
 *   - profit > $50, war              → 70% bribe + min $2
 *   - profit < $20                   → SKIP
 *
 * Floor crítico: bribeBps * profitUsd / 10000 nunca pode ultrapassar 95% do profit.
 * Se passaria, retorna { skip: true }.
 */

import type { BribeConfig } from '@zeus-evm/strategy';
import type { LoggerLike } from '@zeus-evm/aave-discovery';
import type { MarketBribeStats } from '@zeus-evm/execution-utils';
import type { GasWarLevel, GasWarSignals } from './gasWarDetector';

export interface BribeCalculatorOpts {
  /** Profit USD threshold mínimo pra entrar (default $20). Abaixo disso, SKIP. */
  minProfitUsd?: number;
  /** Hard cap em % do profit (default 95). bribeBps real nunca passa disso. */
  hardCapBps?: number;
  /** Fee tier UniV3 do pool profitToken/WETH default (500 = 0.05%). */
  defaultSwapFeeTier?: number;
  /** Slippage default no swap inline (default 50bps = 0.5%). */
  defaultSwapSlippageBps?: number;
  /** Preço estimado ETH/USD pra converter floor USD → minBribeWei. */
  ethUsdPrice: number;
  logger?: LoggerLike;
}

export interface BribeCalcInput {
  /** Profit líquido esperado em USD (após gas + flashloan fee, ANTES do bribe). */
  expectedNetProfitUsd: number;
  /** Nível de gas war detectado (do GasWarDetector). */
  gasWarLevel: GasWarLevel;
  /** Sinais brutos pra log/debug. */
  signals?: GasWarSignals;
  /**
   * Floor de slippage off-chain calculado via Quoter (Audit Pass 4 H-01 protection).
   * Quando passado, `minBribeWei = max(floorUsdWei, swapSlippageFloorWei)`.
   * Quando ausente, usa apenas floor USD (vulnerável a sandwich se profitToken != WETH).
   * Calcular via `computeBribeSlippageFloor` de `@zeus-evm/execution-utils`.
   */
  swapSlippageFloorWei?: bigint;

  /**
   * MARKET-BRIBE (Fase 1) — "lance de mercado" agregado dos competidores
   * (`SenderRegistry.marketBribeStats()`). Quando presente JUNTO de `expectedGasUnits`,
   * o cálculo respeita um PISO: não brigamos abaixo do que o mercado já paga (p75).
   * Ausente → comportamento idêntico ao de antes (tabela fixa). 100% aditivo.
   */
  marketBribeStats?: MarketBribeStats;

  /**
   * Gas units esperado pra nossa tx. Usado pra converter o priority fee de mercado
   * (gwei/gas) em um piso absoluto (ETH→USD). Sem isso, o piso de mercado é ignorado.
   */
  expectedGasUnits?: bigint;
}

export type BribeDecision =
  | { skip: true; reason: string }
  | { skip: false; bribe: BribeConfig; bribeUsd: number; bribeBpsApplied: number };

/**
 * Tabela de bribe por gasWarLevel — % do profit + floor USD.
 * Ajustar via observação real durante DRY_RUN observation period.
 */
const BRIBE_TABLE: Record<GasWarLevel, { bpsBase: number; minFloorUsd: number }> = {
  normal: { bpsBase: 3_000, minFloorUsd: 0.5 }, // 30%
  elevated: { bpsBase: 5_500, minFloorUsd: 1 }, // 55% (média entre 50-60)
  war: { bpsBase: 7_500, minFloorUsd: 2 }, // 75% (média conservadora pra "war")
};

const DEFAULT_MIN_PROFIT_USD = 20;
const DEFAULT_HARD_CAP_BPS = 9_500;
const DEFAULT_SWAP_FEE_TIER = 500;
const DEFAULT_SWAP_SLIPPAGE_BPS = 50n;
const ABSOLUTE_BRIBE_MAX_BPS = 9_900; // bate com ABSOLUTE_BRIBE_CAP_BPS do contrato

export class BribeCalculator {
  private readonly minProfitUsd: number;
  private readonly hardCapBps: number;
  private readonly defaultSwapFeeTier: number;
  private readonly defaultSwapSlippageBps: bigint;
  private readonly ethUsdPrice: number;
  private readonly logger: LoggerLike | undefined;

  constructor(opts: BribeCalculatorOpts) {
    this.minProfitUsd = opts.minProfitUsd ?? DEFAULT_MIN_PROFIT_USD;
    this.hardCapBps = opts.hardCapBps ?? DEFAULT_HARD_CAP_BPS;
    this.defaultSwapFeeTier = opts.defaultSwapFeeTier ?? DEFAULT_SWAP_FEE_TIER;
    this.defaultSwapSlippageBps = BigInt(opts.defaultSwapSlippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS);
    this.ethUsdPrice = opts.ethUsdPrice;
    this.logger = opts.logger;

    if (this.hardCapBps > ABSOLUTE_BRIBE_MAX_BPS) {
      throw new Error(`hardCapBps=${this.hardCapBps} > ${ABSOLUTE_BRIBE_MAX_BPS} (contract cap)`);
    }
  }

  /**
   * Peek do bpsBase da tabela pra um gasWarLevel. Útil pra caller computar
   * `bribeProfitTarget` antes de chamar `decide()` (necessário pra obter
   * o slippage floor via Quoter).
   */
  getBpsForLevel(level: GasWarLevel): number {
    return BRIBE_TABLE[level].bpsBase;
  }

  /** Fee tier UniV3 default usado no swap inline da BribeManager. */
  getDefaultSwapFeeTier(): number {
    return this.defaultSwapFeeTier;
  }

  /** Slippage bps default. */
  getDefaultSwapSlippageBps(): bigint {
    return this.defaultSwapSlippageBps;
  }

  /**
   * Decide bribe pra uma oportunidade. Retorna SKIP quando não vale brigar.
   */
  decide(input: BribeCalcInput): BribeDecision {
    const { expectedNetProfitUsd, gasWarLevel, signals } = input;

    if (expectedNetProfitUsd < this.minProfitUsd) {
      return {
        skip: true,
        reason: `profit $${expectedNetProfitUsd.toFixed(2)} < min $${this.minProfitUsd} — não vale brigar`,
      };
    }

    const tableEntry = BRIBE_TABLE[gasWarLevel];
    const bpsBase = tableEntry.bpsBase;

    // Bribe em USD = profit × bps / 10_000
    let bribeUsd = (expectedNetProfitUsd * bpsBase) / 10_000;

    // Floor USD (mínimo absoluto pra ser competitivo)
    if (bribeUsd < tableEntry.minFloorUsd) {
      bribeUsd = tableEntry.minFloorUsd;
    }

    // ── PISO DE MERCADO (Fase 1) ──
    // Se sabemos quanto o mercado paga (p75 dos competidores) e o gas esperado, garantimos
    // que o nosso lance não fica ABAIXO do mercado — senão perderíamos a corrida de inclusão.
    const marketFloorWei = this._marketFloorWei(input);
    const marketFloorUsd = this._weiToUsd(marketFloorWei);
    // Se o mercado pede MAIS do que o profit aguenta (>95%), não adianta brigar: sangaríamos.
    // Melhor SKIP do que pagar 95% pra ganhar trocados (ou prejuízo). Decisão explícita.
    if (marketFloorUsd > expectedNetProfitUsd * 0.95) {
      return {
        skip: true,
        reason: `mercado pede $${marketFloorUsd.toFixed(2)} (p75) > 95% do profit $${expectedNetProfitUsd.toFixed(2)} — não vale brigar`,
      };
    }
    if (marketFloorUsd > bribeUsd) {
      bribeUsd = marketFloorUsd;
    }

    // Hard cap — bribe nunca passa de hardCapBps do profit
    const hardCapUsd = (expectedNetProfitUsd * this.hardCapBps) / 10_000;
    if (bribeUsd > hardCapUsd) {
      bribeUsd = hardCapUsd;
    }

    // Se o ajuste pelo floor empurrou bribe acima do hard cap → SKIP
    // (bot precisa de profit maior pra cobrir esse floor)
    if (bribeUsd > expectedNetProfitUsd * 0.95) {
      return {
        skip: true,
        reason: `bribe $${bribeUsd.toFixed(2)} > 95% do profit $${expectedNetProfitUsd.toFixed(2)} — sangraria`,
      };
    }

    // Bps efetivo aplicado (recalcula pra refletir floor + cap)
    const bribeBpsApplied = Math.min(
      Math.floor((bribeUsd / expectedNetProfitUsd) * 10_000),
      this.hardCapBps,
    );

    // Floor em wei NATIVE token = max(USD floor, slippage floor off-chain).
    // Slippage floor protege swap inline UniV3 da BribeManager contra sandwich
    // (Audit Pass 4 H-01). USD floor garante competitividade mínima do leilão.
    const usdFloorWei = this._usdToWei(tableEntry.minFloorUsd);
    const slippageFloorWei = input.swapSlippageFloorWei ?? 0n;
    // minBribeWei = max(piso USD, piso slippage, piso de mercado)
    let minBribeWei = usdFloorWei > slippageFloorWei ? usdFloorWei : slippageFloorWei;
    if (marketFloorWei > minBribeWei) minBribeWei = marketFloorWei;

    const bribe: BribeConfig = {
      bribeBps: BigInt(bribeBpsApplied),
      minBribeWei,
      bribeMaxBps: BigInt(this.hardCapBps),
      swapFeeTier: this.defaultSwapFeeTier,
      swapSlippageBps: this.defaultSwapSlippageBps,
    };

    this.logger?.debug(
      {
        level: gasWarLevel,
        expectedNetProfitUsd: expectedNetProfitUsd.toFixed(2),
        bpsBase,
        bribeUsd: bribeUsd.toFixed(2),
        bribeBpsApplied,
        marketP75Gwei: input.marketBribeStats?.p75Gwei,
        marketFloorUsd: marketFloorUsd > 0 ? marketFloorUsd.toFixed(2) : undefined,
        signals,
      },
      `🎯 bribe decided: ${bribeBpsApplied / 100}% = $${bribeUsd.toFixed(2)} (level=${gasWarLevel})`,
    );

    return { skip: false, bribe, bribeUsd, bribeBpsApplied };
  }

  /**
   * Piso de mercado em wei = priority fee p75 (gwei) × gas units esperado.
   * Retorna 0n quando não há dados de mercado ou gas esperado (→ piso desligado).
   */
  private _marketFloorWei(input: BribeCalcInput): bigint {
    const stats = input.marketBribeStats;
    const gas = input.expectedGasUnits;
    if (!stats || stats.competitorsActive === 0 || !gas || gas <= 0n) return 0n;
    if (stats.p75Gwei <= 0) return 0n;
    // gwei → wei: 1 gwei = 1e9 wei. priorityFeePerGas(wei) × gasUnits = total wei.
    const priorityWeiPerGas = BigInt(Math.floor(stats.p75Gwei * 1e9));
    return priorityWeiPerGas * gas;
  }

  /** Converte wei de native token → USD usando ethUsdPrice. */
  private _weiToUsd(wei: bigint): number {
    if (this.ethUsdPrice <= 0 || wei <= 0n) return 0;
    return (Number(wei) / 1e18) * this.ethUsdPrice;
  }

  /**
   * Converte USD → wei de native token usando ethUsdPrice. Native = ETH em chains EVM-padrão.
   */
  private _usdToWei(usd: number): bigint {
    if (this.ethUsdPrice <= 0 || usd <= 0) return 0n;
    const eth = usd / this.ethUsdPrice;
    // wei = eth * 10^18. Usa float→bigint via toFixed pra evitar notação científica
    const wei = BigInt(Math.floor(eth * 1e18));
    return wei;
  }
}
