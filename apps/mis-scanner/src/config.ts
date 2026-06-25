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

  // ─── Execução de ARB (Motor 2) — DESLIGADA por padrão (observação first) ───
  ARB_EXECUTION_ENABLED: boolDefault(false),
  /** dryrun (simula, não submete) | testnet | mainnet. */
  ARB_MODE: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['dryrun', 'testnet', 'mainnet']).default('dryrun')),
  /** Chave EXCLUSIVA do executor (regra inviolável: NÃO reusar entre projetos/ambientes). */
  EXECUTOR_PRIVATE_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional()),
  ARB_EXECUTOR_ADDRESS: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional()),
  ARB_PROFIT_RECEIVER: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional()),
  /** Circuit breaker off-chain: cap absoluto do trade em ETH (espelha MAX_TRADE_ETH do contrato). */
  MAX_TRADE_ETH: num(0.5),
  /** Mínimo de profit líquido (USD) pra disparar. */
  MIN_ARB_PROFIT_USD: num(1),
  ARB_MAX_SLIPPAGE_BPS: posInt(50),
  GAS_COST_USD_ESTIMATE: num(0.5),
  ETH_USD_PRICE_ESTIMATE: num(3000),
  GAS_PRIORITY_FEE_GWEI: num(0.01),
  GAS_MAX_FEE_MULTIPLIER: posInt(200),
  // ── Bribe (gorjeta do gás) competitivo auto-ligável (Motor 2) ──
  /** Liga o auto-ajuste do priority fee (limitado por lucro). Default false = estático.
   *  Mesmo com false, o ZEUS pode AUTO-LIGAR se detectar gas_outbid (ver AUTO_ENABLE abaixo). */
  COMPETITIVE_BRIBE_ENABLED: boolDefault(false),
  /** Percentil de mercado alvo pra ganhar a corrida ('p50' | 'p75' | 'p95'). */
  BRIBE_TARGET_PERCENTILE: z.enum(['p50', 'p75', 'p95']).default('p75'),
  /** Teto RÍGIDO de priority fee (gwei) — sanidade além do teto de lucro. */
  MAX_BRIBE_GWEI: num(5),
  /** Nº de corridas perdidas no gás (gas_outbid) na janela pra o ZEUS auto-ligar o bribe. */
  BRIBE_AUTO_ENABLE_THRESHOLD: posInt(3),
  /** Janela (min) pra contar os gas_outbid do auto-liga. */
  BRIBE_AUTO_ENABLE_WINDOW_MIN: posInt(60),
  /** Notional alvo por tentativa (USD). */
  ARB_NOTIONAL_USD: num(5000),
  /** Quantos pares top (por persistência/viabilidade) tentar por scan. */
  ARB_TOP_N: posInt(5),

  // ─── Auto-calibração (Etapa C) — ajusta o gate de EV a partir do histórico ───
  ADAPTIVE_THRESHOLDS_ENABLED: boolDefault(false),
  ADAPTIVE_RECALC_INTERVAL_SEC: posInt(600),
  ADAPTIVE_WINDOW_DAYS: posInt(7),

  // ─── Controle remoto de execução (toggle do Frontend via Supabase `engine_control`) ───
  // Modelo armado-mas-travado: o bot sobe com ARB_EXECUTION_ENABLED=true + ARB_MODE=mainnet (armado),
  // mas o ENVIO fica TRAVADO até o toggle remoto ligar. Sem SUPABASE_URL → fica travado pra sempre
  // (fail-safe). A escrita no Supabase é feita só pelas rotas /api do Frontend (nunca pelo bot).
  SUPABASE_URL: optionalUrl(),
  /** Chave de LEITURA do Supabase (anon ou service role com RLS de leitura em engine_control). */
  SUPABASE_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Identificador do motor na tabela engine_control. */
  ENGINE_CONTROL_MOTOR: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('motor2')),
  /** A cada quantos ticks de scan reconsultar o toggle remoto. */
  ENGINE_CONTROL_POLL_EVERY: posInt(5),

  // ─── Alerting / ponte pro painel (ZEUS Command) ───
  // Sem isso, NADA do Motor 2 chega ao painel (só M1/M3 mandavam). Aponta pra /api/ingest do Vercel.
  GENERIC_WEBHOOK_URL: optionalUrl(),
  /** Segredo do header x-zeus-secret (= ZEUS_WEBHOOK_SECRET no Vercel). */
  GENERIC_WEBHOOK_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Filtro de severidades (comma-separated). Default: tudo. */
  GENERIC_SEVERITIES: z.string().default('info,warn,critical'),
  /** Intervalo do heartbeat (snapshot ao vivo → painel/service_status) em segundos. */
  HEARTBEAT_EVERY_SEC: posInt(30),
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
