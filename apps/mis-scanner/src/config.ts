/**
 * Config do MIS scanner (Motor 2) — validada via zod.
 *
 * Antes o scanner lia tudo de `process.env` cru: um valor malformado (ex: MIS_SCAN_INTERVAL_MS=abc)
 * virava `Number(...) = NaN` → `setInterval(NaN)` (loop apertado martelando o RPC) OU thresholds NaN
 * (scanner mudo reportando saudável). Aqui falhamos no boot com erro claro. `.finite()` rejeita NaN.
 */

import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../../../.env') });
loadDotenv();

const optionalUrl = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());
/** Número finito (rejeita NaN/Infinity) com default. */
const num = (def: number) => z.coerce.number().finite().default(def);
const posInt = (def: number) => z.coerce.number().int().positive().finite().default(def);
/** Booleano no estilo legado: ausente → default; "false" → false; qualquer outro → true. */
const boolDefault = (def: boolean) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : v !== 'false'), z.boolean());

const envSchema = z.object({
  MIS_CHAIN: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['base', 'avalanche']).default('base')),
  BASE_RPC_HTTP: optionalUrl(),
  AVALANCHE_RPC_HTTP: optionalUrl(),

  MIS_SCAN_INTERVAL_MS: posInt(12_000),
  MIS_RANKING_EVERY: posInt(25),
  MIS_MIN_DIVERGENCE_BPS: num(20),
  /** Default = MIS_MIN_DIVERGENCE_BPS quando ausente (resolvido no loadConfig). */
  MIS_FLASH_MIN_BPS: z.coerce.number().finite().optional(),
  MIS_MAX_SLIPPAGE_BPS: num(500),
  MIS_MAX_DERIVED_PAIRS: posInt(60),
  MIS_DERIVE_TOKENS: boolDefault(true),
  MIS_DERIVE_MORPHO: boolDefault(true),
  MIS_SNAPSHOT_DIR: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

  METRICS_WINDOW_DAYS: num(7),

  HEALTH_SERVER_ENABLED: boolDefault(true),
  HEALTH_SERVER_PORT: posInt(7883),
  HEALTH_SERVER_HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('127.0.0.1')),
});

export type MisEnv = z.infer<typeof envSchema> & { MIS_FLASH_MIN_BPS: number };

let cached: MisEnv | undefined;

export function loadConfig(): MisEnv {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[mis-scanner/config] Variáveis inválidas:');
    console.error(result.error.format());
    throw new Error('Config invalid — fix .env');
  }
  // MIS_FLASH_MIN_BPS default = MIS_MIN_DIVERGENCE_BPS.
  cached = {
    ...result.data,
    MIS_FLASH_MIN_BPS: result.data.MIS_FLASH_MIN_BPS ?? result.data.MIS_MIN_DIVERGENCE_BPS,
  };
  return cached;
}
