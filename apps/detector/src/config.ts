import 'dotenv/config';
import { z } from 'zod';

/**
 * Schema de configuração validado via zod.
 * Lê de process.env e falha early se algo crítico estiver faltando.
 */

const envSchema = z.object({
  // RPC
  BASE_RPC_HTTP: z.string().url(),
  BASE_RPC_WS: z.string().url().optional(),
  BASE_RPC_FALLBACK: z.string().url().optional(),

  // Mempool
  ALCHEMY_API_KEY: z.string().optional(),
  BLOCKNATIVE_API_KEY: z.string().optional(),

  // Wallet
  EXECUTOR_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  EXECUTOR_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  EXECUTOR_OWNER_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // Estratégia
  MAX_TRADE_ETH: z.coerce.number().positive().default(0.1),
  MIN_PROFIT_USD: z.coerce.number().positive().default(5),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(1000).default(50),
  KILL_SWITCH: z.coerce.boolean().default(true),

  // Flashloan
  FLASHLOAN_PROVIDER: z.enum(['aave-v3', 'balancer', 'uniswap-v3']).default('aave-v3'),
  AAVE_V3_POOL: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // Liquidations
  ENABLE_LIQUIDATIONS: z.coerce.boolean().default(false),

  // Monitoring
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Logs
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
