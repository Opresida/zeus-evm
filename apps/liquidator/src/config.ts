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
 * 3 modos de execução do liquidator:
 * - dryrun: pipeline completo MAS sem submeter tx (apenas log do que faria). Read-only.
 * - testnet: submete tx em chains Sepolia (gas testnet, dispatch real).
 * - mainnet: submete tx em chains mainnet (gas real, capital real).
 *
 * Filosofia: começamos `dryrun` em Base mainnet pra calibrar com dados reais, simultaneamente
 * `testnet` pra validar pipeline de submissão. Mainnet só depois de 2 semanas dryrun positivo.
 */
const liquidatorMode = z.enum(['dryrun', 'testnet', 'mainnet']);

const envSchema = z.object({
  // ─── Mode + chain ───
  /** Modo de operação do liquidator. Default fail-safe = dryrun. */
  LIQUIDATOR_MODE: liquidatorMode.default('dryrun'),
  CHAIN_ID: z.coerce.number().int().positive().default(8453),

  // RPC URLs
  BASE_RPC_HTTP: optionalUrl(),
  BASE_RPC_WS: optionalUrl(),
  ARBITRUM_RPC_HTTP: optionalUrl(),
  OPTIMISM_RPC_HTTP: optionalUrl(),
  BASE_SEPOLIA_RPC_HTTP: optionalUrl(),
  ARBITRUM_SEPOLIA_RPC_HTTP: optionalUrl(),
  OPTIMISM_SEPOLIA_RPC_HTTP: optionalUrl(),

  // ─── Wallet ───
  /** Chave privada do bot. Em prod = MPC/hardware. Em dev = testnet wallet dedicada. */
  EXECUTOR_PRIVATE_KEY: optionalString(),
  EXECUTOR_BOT_ADDRESS: optionalAddress(),

  // ─── ZeusExecutor addresses por chain ───
  EXECUTOR_CONTRACT_ADDRESS: optionalAddress(),
  EXECUTOR_CONTRACT_ADDRESS_BASE: optionalAddress(),
  EXECUTOR_CONTRACT_ADDRESS_BASE_SEPOLIA: optionalAddress(),
  EXECUTOR_CONTRACT_ADDRESS_ARBITRUM: optionalAddress(),
  EXECUTOR_CONTRACT_ADDRESS_ARBITRUM_SEPOLIA: optionalAddress(),
  EXECUTOR_CONTRACT_ADDRESS_OPTIMISM: optionalAddress(),
  EXECUTOR_CONTRACT_ADDRESS_OPTIMISM_SEPOLIA: optionalAddress(),

  // ─── Subgraph (reusa do monitor) ───
  THEGRAPH_API_KEY: optionalString(),
  AAVE_V3_BASE_SUBGRAPH_ID: z.string().default('GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF'),
  AAVE_V3_ARBITRUM_SUBGRAPH_ID: z.string().default('DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B'),
  AAVE_V3_OPTIMISM_SUBGRAPH_ID: z.string().default('DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb'),

  // ─── Strategy params ───
  // ⚠️ ATENÇÃO MAINNET PROD: ANTES de ativar LIQUIDATOR_MODE=mainnet, validar que:
  //   - MIN_DEBT_USD >= 100 (defaults de prod, não os baixos de calibração)
  //   - MIN_LIQUIDATION_PROFIT_USD >= 5
  //   - HF_AT_RISK_THRESHOLD <= 1.05
  //   - HF_LIQUIDATABLE_THRESHOLD <= 1.0
  // Em DRY_RUN de calibração esses valores podem ser baixados pra ver mais data, MAS
  // nunca rodar mainnet real com thresholds de teste — geraria dispatches em dust positions
  // que reverteriam queimando gas. Veja TODO.md seção "Pré-ativação mainnet".
  HF_AT_RISK_THRESHOLD: z.coerce.number().positive().default(1.05),
  HF_LIQUIDATABLE_THRESHOLD: z.coerce.number().positive().default(1.0),
  MIN_DEBT_USD: z.coerce.number().positive().default(100),
  MIN_LIQUIDATION_PROFIT_USD: z.coerce.number().positive().default(5),

  // ─── Liquidator-específico ───
  /** Polling interval entre ciclos de busca (segundos). Caminho A = 60s. */
  LIQUIDATOR_POLL_INTERVAL_SEC: z.coerce.number().int().positive().default(60),
  /** Close factor aplicado em liquidations Aave (max 0.5 = 50% da debt). */
  AAVE_CLOSE_FACTOR: z.coerce.number().min(0.01).max(0.5).default(0.5),
  /** Slippage máximo tolerado em swaps (basis points). 50 = 0.5%. */
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(1000).default(50),
  /** Cap de % da liquidez do pool em swap (proteção contra over-trade). */
  POOL_LIQUIDITY_CAP_PCT: z.coerce.number().min(0.01).max(0.5).default(0.1),
  /** Gas estimate em USD pra liquidations (Base ~ $0.20-0.50, ajustar via observação). */
  GAS_COST_USD_ESTIMATE: z.coerce.number().positive().default(0.5),
  /** Preço estimado de ETH em USD pra calcular gasCostUsd nos logs.
   *  ⚠️ Hardcoded MVP — refinar via Chainlink oracle on-chain depois. */
  ETH_USD_PRICE_ESTIMATE: z.coerce.number().positive().default(3000),

  // ─── Daily loss limit (gap crítico #1) ───
  /** Limite máximo de loss em USD nas últimas 24h. Quando ultrapassado, kill switch
   *  é acionado automaticamente: dispatches futuros bloqueados + (se autoKillEnabled)
   *  contrato é killed on-chain. Default conservador. */
  DAILY_LOSS_LIMIT_USD: z.coerce.number().positive().default(100),
  /** Caminho do arquivo JSONL onde PnL events são persistidos (sobrevive restart). */
  PNL_LOG_FILE: z.string().default('logs/pnl-events.jsonl'),
  /** Se true E modo != dryrun, dispara executor.kill() on-chain quando limit atingido.
   *  Em dryrun fica sempre false (não submete nada). */
  AUTO_KILL_SWITCH_ENABLED: z.coerce.boolean().default(true),

  // ─── Cooldown após N falhas seguidas (gap crítico #2) ───
  /** Número de falhas CONSECUTIVAS pra ativar cooldown automático.
   *  Sucesso reseta o contador. Falhas pre-dispatch (gate simulação) NÃO contam. */
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
  /** Duração do cooldown em segundos quando MAX_CONSECUTIVE_FAILURES é atingido.
   *  Default 5min — tempo pra calibração entre tentativas. */
  COOLDOWN_DURATION_SEC: z.coerce.number().int().positive().default(300),

  // ─── Position deduplication (gap crítico #3) ───
  /** Timeout (segundos) pra tx em pending. Se receipt não chega nesse tempo,
   *  liberamos position pra retry (assume tx perdida/travada). Default 5min. */
  DEDUP_PENDING_TIMEOUT_SEC: z.coerce.number().int().positive().default(300),
  /** TTL (segundos) que position confirmed/failed fica bloqueada pra re-tentativa.
   *  Após esse tempo, subgraph já indexou novo estado e position pode ser re-processada. */
  DEDUP_RECENT_TTL_SEC: z.coerce.number().int().positive().default(300),

  // ─── Gas reserve monitoring (gap crítico #4) ───
  /** Threshold WARN em ETH — abaixo disso loga alerta (não bloqueia). Default 0.05 ETH (~$150). */
  GAS_RESERVE_WARN_ETH: z.coerce.number().positive().default(0.05),
  /** Threshold CRITICAL em ETH — abaixo disso bloqueia dispatches (com flag).
   *  Default 0.01 ETH (~$30) = cobre ~60-150 tx de liquidation em Base. */
  GAS_RESERVE_CRITICAL_ETH: z.coerce.number().positive().default(0.01),
  /** Se true, dispatches ficam bloqueados quando balance < critical threshold.
   *  Default true (segurança). Em dryrun não tem efeito (sem wallet). */
  BLOCK_DISPATCH_ON_CRITICAL_GAS: z.coerce.boolean().default(true),

  // ─── Alerting (event bus + webhooks) ───
  /** URL do webhook Discord pra alertas formatados (embeds). Vazio = sink Discord não ativa.
   *  Criar webhook em canal SEU privado: Server > Integrations > Webhooks > New */
  DISCORD_WEBHOOK_URL: optionalUrl(),
  /** URL genérica pra POST JSON dos eventos crus (sem formatação Discord).
   *  Útil pra Telegram bot, mini server local, n8n, futuro WebSocket gateway. */
  GENERIC_WEBHOOK_URL: optionalUrl(),
  /** Filtro de severidades pro Discord (comma-separated). Default: 'warn,critical' (sem info pra evitar spam).
   *  Override pra 'info,warn,critical' se quiser ver TUDO durante calibração. */
  DISCORD_SEVERITIES: z.string().default('warn,critical'),
  /** Filtro de severidades pro generic webhook. Default: 'info,warn,critical' (envia tudo). */
  GENERIC_SEVERITIES: z.string().default('info,warn,critical'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type LiquidatorEnv = z.infer<typeof envSchema>;
export type LiquidatorMode = z.infer<typeof liquidatorMode>;

let cached: LiquidatorEnv | undefined;

export function loadConfig(): LiquidatorEnv {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[liquidator/config] Variáveis inválidas:');
    console.error(result.error.format());
    throw new Error('Config invalid — fix .env');
  }
  cached = result.data;
  return cached;
}
