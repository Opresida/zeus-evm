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
  // ─── RPC config — multi-chain ───
  // Pra cada chain, usamos uma var separada. CHAIN_ID escolhe qual usar.
  /** chainId da chain alvo. Default = Base (8453) por retrocompat. */
  CHAIN_ID: z.coerce.number().int().positive().default(8453),

  // RPC URLs por chain (vazios são OK se essa chain não for usada)
  BASE_RPC_HTTP: optionalUrl(),
  BASE_RPC_WS: optionalUrl(),
  ARBITRUM_RPC_HTTP: optionalUrl(),
  ARBITRUM_RPC_WS: optionalUrl(),
  OPTIMISM_RPC_HTTP: optionalUrl(),
  OPTIMISM_RPC_WS: optionalUrl(),
  // Testnets
  BASE_SEPOLIA_RPC_HTTP: optionalUrl(),
  ARBITRUM_SEPOLIA_RPC_HTTP: optionalUrl(),
  OPTIMISM_SEPOLIA_RPC_HTTP: optionalUrl(),

  EXECUTOR_CONTRACT_ADDRESS: optionalAddress(),
  EXECUTOR_BOT_ADDRESS: optionalAddress(),

  // Monitor-específico
  /** API key da TheGraph (free, sign up em thegraph.com/studio) */
  THEGRAPH_API_KEY: optionalString(),
  // Subgraph IDs por chain (defaults = oficiais Aave V3)
  AAVE_V3_BASE_SUBGRAPH_ID: z.string().default('GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF'),
  AAVE_V3_ARBITRUM_SUBGRAPH_ID: z.string().default('DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B'),
  AAVE_V3_OPTIMISM_SUBGRAPH_ID: z.string().default('DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb'),

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
