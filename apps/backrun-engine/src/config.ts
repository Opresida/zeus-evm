/**
 * Backrun-engine env schema.
 *
 * Reusa chaves do liquidator quando possível (mesma wallet, mesmo executor),
 * adiciona específicas de mempool/backrun.
 */

import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../../../.env') });
loadDotenv();

const optionalString = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalUrl = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
const optionalAddress = () =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional());

/**
 * Backrun engine roda em 3 modos análogos ao liquidator:
 *   - dryrun: pipeline completo SEM submeter tx
 *   - testnet: submete em Sepolia (gas testnet)
 *   - mainnet: submete em mainnet (gas real)
 */
const backrunMode = z.enum(['dryrun', 'testnet', 'mainnet']);

const envSchema = z.object({
  // ─── Mode + chain ───
  BACKRUN_MODE: backrunMode.default('dryrun'),
  CHAIN_ID: z.coerce.number().int().positive().default(8453),

  // RPC URLs (primary + fallback gratuito pra resiliência)
  BASE_RPC_HTTP: optionalUrl(),
  BASE_RPC_HTTP_FALLBACK: optionalUrl(),
  BASE_RPC_WS: optionalUrl(),
  BASE_SEPOLIA_RPC_HTTP: optionalUrl(),
  BASE_SEPOLIA_RPC_HTTP_FALLBACK: optionalUrl(),
  OPTIMISM_RPC_HTTP: optionalUrl(),
  OPTIMISM_RPC_HTTP_FALLBACK: optionalUrl(),
  /** Alchemy mempool WSS — exige plano Growth+ (alchemy_pendingTransactions).
   *  Quando vazio, o subscription roda em PLACEHOLDER mode (sem feed real). */
  ALCHEMY_MEMPOOL_WSS_URL: optionalUrl(),

  // ─── Wallet (mesma do liquidator — reusa) ───
  EXECUTOR_PRIVATE_KEY: optionalString(),
  EXECUTOR_BOT_ADDRESS: optionalAddress(),

  // ─── ZeusExecutor address (chain-active) ───
  // Pre-v8: EXECUTOR_CONTRACT_ADDRESS_* apontava pro contrato monolítico.
  // V8: usar ARB_EXECUTOR_ADDRESS_* (aponta pro ZeusArbExecutor). EXECUTOR_CONTRACT_ADDRESS_*
  // fica como fallback pra deploys pre-v8 ainda em uso.
  EXECUTOR_CONTRACT_ADDRESS: optionalAddress(),
  EXECUTOR_CONTRACT_ADDRESS_BASE: optionalAddress(),

  // V8: ZeusArbExecutor address (split do monolítico)
  ARB_EXECUTOR_ADDRESS: optionalAddress(),
  ARB_EXECUTOR_ADDRESS_BASE: optionalAddress(),
  ARB_EXECUTOR_ADDRESS_BASE_SEPOLIA: optionalAddress(),
  ARB_EXECUTOR_ADDRESS_OPTIMISM: optionalAddress(),

  // ─── Backrun-específico ───
  /** Threshold em USD pra considerar um swap "whale" (default $50k).
   *  Abaixo disso, ignoramos — provavelmente não move preço o suficiente. */
  BACKRUN_MIN_SWAP_USD: z.coerce.number().positive().default(50_000),
  /** Profit mínimo USD do nosso backrun pra valer o gas. */
  MIN_BACKRUN_PROFIT_USD: z.coerce.number().positive().default(2),
  /** Cap máximo do flashloan em USD (proteção sizing). */
  MAX_BACKRUN_FLASHLOAN_USD: z.coerce.number().positive().default(50_000),
  /** Min flashloan size em USD pra evitar dust. */
  MIN_BACKRUN_FLASHLOAN_USD: z.coerce.number().positive().default(100),
  /** Slippage máximo tolerado nos swaps (bps). */
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(1000).default(50),
  /** Gas estimate em USD pra Base. */
  GAS_COST_USD_ESTIMATE: z.coerce.number().positive().default(0.5),
  /** Preço ETH/USD pra estimar gasCost. */
  ETH_USD_PRICE_ESTIMATE: z.coerce.number().positive().default(3000),
  /** Sample size do planner (nº de amountIn candidatos). */
  BACKRUN_SAMPLE_SIZE: z.coerce.number().int().positive().default(8),

  // ─── Daily loss limit (reusa do liquidator) ───
  DAILY_LOSS_LIMIT_USD: z.coerce.number().positive().default(100),
  PNL_LOG_FILE: z.string().default('logs/backrun-pnl.jsonl'),

  // ─── Cooldown ───
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
  COOLDOWN_DURATION_SEC: z.coerce.number().int().positive().default(300),

  // ─── EIP-1559 gas pricing ───
  GAS_PRIORITY_FEE_GWEI: z.coerce.number().positive().default(0.001),
  GAS_MAX_FEE_MULTIPLIER: z.coerce.number().positive().default(2),

  // ─── Alerting ───
  DISCORD_WEBHOOK_URL: optionalUrl(),
  GENERIC_WEBHOOK_URL: optionalUrl(),
  DISCORD_SEVERITIES: z.string().default('warn,critical'),
  GENERIC_SEVERITIES: z.string().default('info,warn,critical'),

  // ─── Bundle relays (V7) ───
  /** URL do Flashbots relay. Mainnet default = https://relay.flashbots.net. */
  FLASHBOTS_RELAY_URL: optionalUrl(),
  /** Signing key pra reputation tracking no Flashbots (não é a key do bot, é separada). */
  FLASHBOTS_AUTH_KEY: optionalString(),
  /** URL FastLane Atlas (Base/Polygon). Placeholder até integrarmos UserOp encoding. */
  ATLAS_RELAY_URL: optionalUrl(),
  /** URL Blocknative MEV relay (multi-chain). */
  BLOCKNATIVE_RELAY_URL: optionalUrl(),
  /** Timeout em ms pra submit a cada relay (default 4000). */
  RELAY_TIMEOUT_MS: z.coerce.number().int().positive().default(4_000),

  // ─── Bribe config defaults (V7) ───
  /** Hard cap em bps. Bribe nunca ultrapassa essa fração do profit. Default 9500 = 95%. */
  BRIBE_HARD_CAP_BPS: z.coerce.number().int().min(100).max(9_900).default(9_500),
  /** Fee tier UniV3 default pro pool profitToken/WETH no swap inline (500 = 0.05%). */
  BRIBE_SWAP_FEE_TIER: z.coerce.number().int().positive().default(500),
  /** Slippage default no swap inline (bps). Default 50 = 0.5%. */
  BRIBE_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(1_000).default(50),
  /** Profit USD mínimo pra entrar em leilão de bribe. Abaixo disso, SKIP. */
  BRIBE_MIN_PROFIT_USD: z.coerce.number().positive().default(20),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type BackrunEnv = z.infer<typeof envSchema>;
export type BackrunMode = z.infer<typeof backrunMode>;

let cached: BackrunEnv | undefined;

export function loadConfig(): BackrunEnv {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[backrun-engine/config] Variáveis inválidas:');
    console.error(result.error.format());
    throw new Error('Config invalid — fix .env');
  }
  cached = result.data;
  return cached;
}
