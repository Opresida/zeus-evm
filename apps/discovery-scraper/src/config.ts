/**
 * Discovery scraper config — env vars + chain identifiers.
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

const envSchema = z.object({
  // ─── Sources ───
  /** Override URL GeckoTerminal — default https://api.geckoterminal.com/api/v2 */
  GECKO_TERMINAL_BASE_URL: optionalUrl(),
  /** Override URL DefiLlama yields — default https://yields.llama.fi */
  DEFILLAMA_BASE_URL: optionalUrl(),

  // ─── Scraper params ───
  /** Quantos top candidates listar por chain. */
  SCRAPER_TOP_N: z.coerce.number().int().positive().default(10),
  /** TVL mínimo USD pra par entrar no scoring (hard filter). */
  SCRAPER_MIN_TVL_USD: z.coerce.number().positive().default(100_000),
  /** Volume 24h mínimo USD (hard filter). */
  SCRAPER_MIN_VOLUME_24H_USD: z.coerce.number().positive().default(50_000),
  /** Idade mínima do pool em dias (hard filter — rug protection). */
  SCRAPER_MIN_POOL_AGE_DAYS: z.coerce.number().int().min(0).default(7),
  /** Timeout pra cada chamada HTTP (ms). */
  SCRAPER_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // ─── Outputs ───
  /** Discord webhook URL (opt). Quando setado, envia relatório diário formatado. */
  DISCORD_WEBHOOK_URL: optionalUrl(),
  /** Pasta onde salvar JSON snapshots. Default ./reports/ */
  SCRAPER_REPORTS_DIR: z.string().default('reports'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ScraperEnv = z.infer<typeof envSchema>;

/**
 * Chains suportadas pelo scraper. Mapeia chainId → identificador GeckoTerminal.
 *
 * Adicionar nova chain = 1 linha aqui. Pares descobertos do scraper podem ser
 * promovidos pra target-pairs.ts da chain (F3 entrega o approval flow).
 *
 * Chains incluídas refletem o roadmap do ZEUS:
 *   - Base (8453): chain primária, backrun + liquidator ativos
 *   - Optimism (10): expansão F1 — backrun com Velodrome
 *   - Arbitrum (42161): expansão futura — pares no Camelot/Ramses
 *   - Polygon (137): expansão futura — Aave V3 + Compound III
 *   - Avalanche (43114): expansão futura — Aave V3 only
 */
export const SUPPORTED_CHAINS = [
  { chainId: 8453, name: 'Base', geckoNetwork: 'base' },
  { chainId: 10, name: 'OP Mainnet', geckoNetwork: 'optimism' },
  { chainId: 42161, name: 'Arbitrum', geckoNetwork: 'arbitrum' },
  { chainId: 137, name: 'Polygon', geckoNetwork: 'polygon_pos' },
  { chainId: 43114, name: 'Avalanche', geckoNetwork: 'avax' },
] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

let cached: ScraperEnv | undefined;

export function loadConfig(): ScraperEnv {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[discovery-scraper/config] Vars inválidas:');
    console.error(result.error.format());
    throw new Error('Config invalid — fix .env');
  }
  cached = result.data;
  return cached;
}
