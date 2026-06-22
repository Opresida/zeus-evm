import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ESM: deriva __dirname manualmente
const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega .env da raiz do monorepo (3 níveis acima: apps/detector/src/)
loadDotenv({ path: resolve(__dirname, '../../../.env') });
// Fallback: tenta cwd também (se rodar de outro lugar)
loadDotenv();

/**
 * Schema de configuração validado via zod.
 * Lê de process.env e falha early se algo crítico estiver faltando.
 */

/** Trata string vazia como undefined (zod aceita undefined com .optional()) */
const optionalString = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalUrl = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
const optionalAddress = () =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional());
const optionalPrivateKey = () =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional());

const envSchema = z.object({
  // RPC
  BASE_RPC_HTTP: z.string().url(),
  BASE_RPC_WS: optionalUrl(),
  BASE_RPC_FALLBACK: optionalUrl(),

  // Mempool
  ALCHEMY_API_KEY: optionalString(),
  BLOCKNATIVE_API_KEY: optionalString(),

  // Wallet
  EXECUTOR_PRIVATE_KEY: optionalPrivateKey(),
  /** Endereço do contrato ZeusExecutor deployado on-chain (usado como `to:` na simulação) */
  EXECUTOR_CONTRACT_ADDRESS: optionalAddress(),
  /** EOA do bot — quem assina txs (derivado da private key) */
  EXECUTOR_BOT_ADDRESS: optionalAddress(),
  /** Owner do contrato (em dev = bot; em prod = multisig) */
  EXECUTOR_OWNER_ADDRESS: optionalAddress(),
  /** @deprecated usar EXECUTOR_CONTRACT_ADDRESS */
  EXECUTOR_ADDRESS: optionalAddress(),

  // Estratégia
  MAX_TRADE_ETH: z.coerce.number().positive().default(0.1),
  MIN_PROFIT_USD: z.coerce.number().positive().default(5),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(1000).default(50),
  KILL_SWITCH: z.coerce.boolean().default(true),

  // Flashloan
  FLASHLOAN_PROVIDER: z.enum(['aave-v3', 'balancer', 'uniswap-v3']).default('aave-v3'),
  AAVE_V3_POOL: optionalAddress(),

  // Liquidations
  ENABLE_LIQUIDATIONS: z.coerce.boolean().default(false),

  // Monitoring
  DISCORD_WEBHOOK_URL: optionalUrl(),
  TELEGRAM_BOT_TOKEN: optionalString(),
  TELEGRAM_CHAT_ID: optionalString(),

  // Logs
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Observabilidade (OIE Etapa D) — health server + /metrics pra Grafana ler o DRY_RUN
  HEALTH_SERVER_ENABLED: z.coerce.boolean().default(true),
  HEALTH_SERVER_PORT: z.coerce.number().int().min(1024).max(65535).default(7882),
  HEALTH_SERVER_HOST: z.string().default('127.0.0.1'),
  /** Janela (dias) do bridge de métricas de observação. */
  METRICS_WINDOW_DAYS: z.coerce.number().positive().default(7),
});

export type Env = z.infer<typeof envSchema>;

let cachedConfig: Env | undefined;

/**
 * Carrega + valida config. Use no boot do app.
 * Falha early se variável crítica estiver faltando.
 */
export function loadConfig(): Env {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] Variáveis inválidas:');
    console.error(result.error.format());
    throw new Error('Config invalid — fix .env');
  }

  cachedConfig = result.data;
  return cachedConfig;
}

export function getConfig(): Env {
  if (!cachedConfig) throw new Error('Config not loaded — chame loadConfig() no boot');
  return cachedConfig;
}
