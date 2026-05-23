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

const envSchema = z.object({
  BASE_RPC_HTTP: z.string().url(),
  BASE_RPC_WS: optionalUrl(),

  EXECUTOR_CONTRACT_ADDRESS: optionalAddress(),
  EXECUTOR_BOT_ADDRESS: optionalAddress(),

  // Monitor-específico
  /** Subgraph ID do Aave V3 Base (default: oficial) */
  AAVE_V3_BASE_SUBGRAPH_ID: z.string().default('GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF'),
  /** API key da TheGraph (free, sign up em thegraph.com/studio) */
  THEGRAPH_API_KEY: optionalString(),
  /** HF threshold pra considerar "em risco" e re-checar on-chain */
  HF_AT_RISK_THRESHOLD: z.coerce.number().positive().default(1.05),
  /** HF threshold pra disparar liquidação */
  HF_LIQUIDATABLE_THRESHOLD: z.coerce.number().positive().default(1.0),
  /** Debt mínimo em USD pra considerar a position (filtra dust) */
  MIN_DEBT_USD: z.coerce.number().positive().default(100),
  /** Profit mínimo esperado em USD pra disparar liquidação */
  MIN_LIQUIDATION_PROFIT_USD: z.coerce.number().positive().default(5),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type MonitorEnv = z.infer<typeof envSchema>;

let cached: MonitorEnv | undefined;

export function loadConfig(): MonitorEnv {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[monitor/config] Variáveis inválidas:');
    console.error(result.error.format());
    throw new Error('Config invalid — fix .env');
  }
  cached = result.data;
  return cached;
}
