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

  // ─── RPC URLs por chain (pra competition tracking on-chain) ───
  BASE_RPC_HTTP: optionalUrl(),
  BASE_RPC_HTTP_FALLBACK: optionalUrl(),
  OPTIMISM_RPC_HTTP: optionalUrl(),
  OPTIMISM_RPC_HTTP_FALLBACK: optionalUrl(),
  ARBITRUM_RPC_HTTP: optionalUrl(),
  ARBITRUM_RPC_HTTP_FALLBACK: optionalUrl(),
  POLYGON_RPC_HTTP: optionalUrl(),
  POLYGON_RPC_HTTP_FALLBACK: optionalUrl(),
  AVAX_RPC_HTTP: optionalUrl(),
  AVAX_RPC_HTTP_FALLBACK: optionalUrl(),

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
  /** State file path (controle remoto). Default ./state/scraper-state.json */
  SCRAPER_STATE_PATH: z.string().default('state/scraper-state.json'),
  /** Cache dir (token safety). Default ./state/ */
  SCRAPER_CACHE_DIR: z.string().default('state'),

  // ─── Health server (F5) ───
  /** Se true, sobe HTTP server em loopback pra /health + controle remoto.
   *  Pra deploy em servidor: ATIVAR. Pra runs CLI únicos: deixar false. */
  HEALTH_SERVER_ENABLED: z.coerce.boolean().default(false),
  /** Porta do health server. Default 7878. */
  HEALTH_SERVER_PORT: z.coerce.number().int().min(1024).max(65535).default(7878),
  /** Host bind. Default 127.0.0.1 (loopback). Use '0.0.0.0' pra expor (atrás de proxy). */
  HEALTH_SERVER_HOST: z.string().default('127.0.0.1'),

  // ─── Competition tracking (F4) ───
  /** Se true, scaneia logs on-chain pra medir densidade de bots por par.
   *  Adiciona ~2-3 min ao sweep total (cache 6h amortiza). Default true. */
  SCRAPER_COMPETITION_ENABLED: z.coerce.boolean().default(true),
  /** Blocos pra trás pra scanear (cada chain). Default 5000 (~3h Base, ~50min Polygon). */
  SCRAPER_COMPETITION_BLOCK_RANGE: z.coerce.number().int().positive().default(5_000),

  // ─── Auto-targets (F3) ───
  /** Diretório onde scraper escreve <chain>.json pra backrun-engine consumir.
   *  Default: ../backrun-engine/auto-targets/ (path relativo). */
  SCRAPER_AUTO_TARGETS_DIR: z.string().default('../backrun-engine/auto-targets'),
  /** Score mínimo composite pra par ENTRAR no auto-targets (default 50). Promoção
   *  é condicional: score ≥65 promove em 1 cycle, 50-65 em 2 cycles consecutivos. */
  SCRAPER_MIN_AUTO_SCORE: z.coerce.number().min(0).max(100).default(50),
  /** Path do tracking state (anti-flicker — cycles consecutivos). */
  SCRAPER_AUTO_TRACKING_PATH: z.string().default('state/auto-targets-tracking.json'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ScraperEnv = z.infer<typeof envSchema>;

/**
 * Chains suportadas pelo scraper. Mapeia chainId → identificador GeckoTerminal.
 *
 * `poolPages` define quanta profundidade (cada page = 20 pools, ordenados por TVL desc):
 *   - Chains com backrun ATIVO (Base + Optimism): 15 pages = top 300 pools (deep scan)
 *   - Chains apenas intel (Arb + Polygon + Avalanche): 5 pages = top 100 pools
 *
 * Quando ativarmos backrun em outra chain, mudamos a chain pra deep scan (15 pages).
 */
export const SUPPORTED_CHAINS = [
  { chainId: 8453, name: 'Base', geckoNetwork: 'base', poolPages: 15, isBackrunActive: true },
  { chainId: 10, name: 'OP Mainnet', geckoNetwork: 'optimism', poolPages: 15, isBackrunActive: true },
  { chainId: 42161, name: 'Arbitrum', geckoNetwork: 'arbitrum', poolPages: 5, isBackrunActive: false },
  { chainId: 137, name: 'Polygon', geckoNetwork: 'polygon_pos', poolPages: 5, isBackrunActive: false },
  { chainId: 43114, name: 'Avalanche', geckoNetwork: 'avax', poolPages: 5, isBackrunActive: false },
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
