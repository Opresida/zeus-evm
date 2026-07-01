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
 * Booleano de env CORRETO. `z.coerce.boolean()` faz `Boolean(string)` → QUALQUER string não-vazia
 * vira `true` (inclusive "false"!), um footgun perigoso pra flags de segurança. Aqui "false"/"0"/
 * "no"/"off"/"" → false; "true"/"1"/"yes"/"on" → true; ausente → default. Case-insensitive.
 */
const boolEnv = (def: boolean) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const s = v.trim().toLowerCase();
    if (s === '') return undefined; // vazio → usa default
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    return v; // valor inesperado → deixa o zod reclamar
  }, z.boolean().default(def));

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

export const envSchema = z.object({
  // ─── Mode + chain ───
  /** Modo de operação do liquidator. Default fail-safe = dryrun. */
  LIQUIDATOR_MODE: liquidatorMode.default('dryrun'),
  CHAIN_ID: z.coerce.number().int().positive().default(8453),

  // RPC URLs
  BASE_RPC_HTTP: optionalUrl(),
  /** Fallback de RPC pra Base (ex: Alchemy). Viem faz failover automático se o primário falhar. */
  BASE_RPC_HTTP_FALLBACK: optionalUrl(),
  BASE_RPC_WS: optionalUrl(),
  ARBITRUM_RPC_HTTP: optionalUrl(),
  OPTIMISM_RPC_HTTP: optionalUrl(),
  POLYGON_RPC_HTTP: optionalUrl(),
  AVALANCHE_RPC_HTTP: optionalUrl(),
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
  EXECUTOR_CONTRACT_ADDRESS_POLYGON: optionalAddress(),
  EXECUTOR_CONTRACT_ADDRESS_AVALANCHE: optionalAddress(),

  // ─── V8: contratos splittados (ZeusLiquidator + ZeusArbExecutor + BribeManager) ───
  // Liquidator app usa LIQUIDATOR_ADDRESS_*. Quando não setado, fallback pra EXECUTOR_CONTRACT_ADDRESS_*
  // (mantém retrocompat com deploys v6/v7 já existentes em mainnet).
  LIQUIDATOR_ADDRESS: optionalAddress(),
  LIQUIDATOR_ADDRESS_BASE: optionalAddress(),
  LIQUIDATOR_ADDRESS_BASE_SEPOLIA: optionalAddress(),
  LIQUIDATOR_ADDRESS_ARBITRUM: optionalAddress(),
  LIQUIDATOR_ADDRESS_ARBITRUM_SEPOLIA: optionalAddress(),
  LIQUIDATOR_ADDRESS_OPTIMISM: optionalAddress(),
  LIQUIDATOR_ADDRESS_OPTIMISM_SEPOLIA: optionalAddress(),
  LIQUIDATOR_ADDRESS_POLYGON: optionalAddress(),
  LIQUIDATOR_ADDRESS_AVALANCHE: optionalAddress(),

  // BribeManager address (compartilhado entre Liquidator e ArbExecutor — pra decoder de evento)
  BRIBE_MANAGER_ADDRESS: optionalAddress(),
  BRIBE_MANAGER_ADDRESS_BASE: optionalAddress(),
  BRIBE_MANAGER_ADDRESS_BASE_SEPOLIA: optionalAddress(),

  // ─── Subgraph (reusa do monitor) ───
  THEGRAPH_API_KEY: optionalString(),
  AAVE_V3_BASE_SUBGRAPH_ID: z.string().default('GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF'),
  AAVE_V3_ARBITRUM_SUBGRAPH_ID: z.string().default('DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B'),
  AAVE_V3_OPTIMISM_SUBGRAPH_ID: z.string().default('DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb'),
  /** Aave V3 Polygon. Vazio = discovery on-chain (event scan). Preencher se quiser subgraph. */
  AAVE_V3_POLYGON_SUBGRAPH_ID: z.string().default(''),
  /** Aave V3 Avalanche. Vazio = discovery on-chain (event scan). */
  AAVE_V3_AVALANCHE_SUBGRAPH_ID: z.string().default(''),
  /** Subgraph do Seamless (Aave fork em Base). Vazio = discovery on-chain (Opção 3).
   *  Se preenchido, usa subgraph (mais eficiente); senão, event scan on-chain. */
  AAVE_SEAMLESS_BASE_SUBGRAPH_ID: z.string().default(''),
  /** Janela de blocos pro discovery on-chain de Aave forks (event scan Borrow).
   *  Free tier dRPC/Alchemy: ~10k blocos seguro. Base ~2s/bloco = ~5.5h de lookback. */
  AAVE_ONCHAIN_BLOCK_LOOKBACK: z.coerce.number().int().min(1000).max(100000).default(10000),

  // ─── Morpho Blue (Grupo C) ───
  /** Habilita discovery + liquidation Morpho Blue (markets isolados). */
  MORPHO_ENABLED: boolEnv(true),
  /** Lookback de blocos pra enumerar markets via CreateMarket events (histórico). */
  MORPHO_MARKETS_LOOKBACK: z.coerce.number().int().min(100000).max(10000000).default(2000000),

  // ─── Moonwell (Compound V2 fork — Grupo C) ───
  /** Habilita discovery + liquidation Moonwell. Requer MOONWELL_LIQUIDATOR_ADDRESS pra dispatch real. */
  MOONWELL_ENABLED: boolEnv(true),
  /** Endereço do ZeusMoonwellLiquidator deployado (contrato SEPARADO). Vazio = só DRY_RUN log. */
  MOONWELL_LIQUIDATOR_ADDRESS: optionalAddress(),

  // ─── Porteiro de tokens (vetting) — Motor 1 (Etapas 4-5) ───
  VETTING_ENABLED: boolEnv(false), // chave-mestra do porteiro (off por padrão)
  VETTING_M1_OBSERVE: boolEnv(true), // sob a mestra: veta o colateral do M1 e mostra no painel (NÃO filtra)
  VETTING_M1_ENFORCE: boolEnv(false), // chave-mestra do filtro do M1; liga/desliga ao vivo é o toggle do painel
  VETTING_SAFETY_CACHE_DIR: z.string().default('.cache'), // onde fica o token-safety-cache.json
  // ── Etapa 6: porteiro VIVO (re-check contínuo + liquidez round-trip) ──
  VETTING_REVET_ENABLED: boolEnv(false), // re-veta o universo num loop (auto-demote/auto-promote)
  VETTING_REVET_SEC: z.coerce.number().positive().default(600), // intervalo do re-vet (10 min)
  VETTING_DEEP_LIQUIDITY: boolEnv(false), // liga o round-trip (USDC→token→USDC) — liquidez REAL
  VETTING_MAX_ROUNDTRIP_BPS: z.coerce.number().positive().default(300), // perda máx no round-trip (3%)
  VETTING_ROUNDTRIP_USD: z.coerce.number().positive().default(1000), // notional do round-trip

  // ─── Morpho PRÉ-liquidação (Motor 1 — pre-liquidation) ───
  /** Habilita discovery + pré-liquidação Morpho (faixa preLltv<LTV<LLTV, callback+swap zero-capital). */
  MORPHO_PRELIQ_ENABLED: boolEnv(false),
  /** Endereço do ZeusMorphoPreLiquidator deployado (contrato SEPARADO). Vazio = só DRY_RUN log. */
  PRE_LIQUIDATOR_ADDRESS: optionalAddress(),
  /** Lookback de blocos pra enumerar contratos PreLiquidation via CreatePreLiquidation events. */
  MORPHO_PRELIQ_FACTORY_LOOKBACK: z.coerce.number().int().min(100000).max(20000000).default(5000000),

  // ─── Wallet-pool (Motor 1 — presença paralela no grind de pré-liquidação) ───
  // Default DESLIGADO. Wiring no dispatch + movimentação real de fundo = fase mainnet (pós-DRY_RUN).
  /** Liga o pool de N EOAs paralelos. Requer WALLET_POOL_MNEMONIC. Fail-safe: sem seed → erro no boot. */
  WALLET_POOL_ENABLED: boolEnv(false),
  /** Seed-mestre BIP-39 do pool (CHAVE-MESTRA — dedicada, nunca reusar de outro projeto). */
  WALLET_POOL_MNEMONIC: optionalString(),
  /** Nº de EOAs no pool (~22 = metade do líder de 44; subir conforme o edge). */
  WALLET_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(22),
  /** Índice HD inicial da derivação (m/44'/60'/0'/0/N). */
  WALLET_POOL_START_INDEX: z.coerce.number().int().min(0).default(0),
  /** ⚠️ Teto de exposição AGREGADA (ETH) somando TODOS os senders (cuidado #1). Pré-condição HARD. */
  WALLET_POOL_MAX_AGGREGATE_ETH: z.coerce.number().positive().default(0.2),
  /** ⚠️ Máx de fills SIMULTÂNEAS entre todos os senders (breaker agregado v1 = limita o N× concorrente). */
  WALLET_POOL_MAX_CONCURRENT: z.coerce.number().int().positive().default(8),
  /** Gatilho de top-up de gás por EOA (ETH): abaixo disso, reabastece. */
  WALLET_POOL_GAS_MIN_ETH: z.coerce.number().positive().default(0.003),
  /** Alvo de gás por EOA pós-top-up (ETH). Deve ser ≥ WALLET_POOL_GAS_MIN_ETH. */
  WALLET_POOL_GAS_TARGET_ETH: z.coerce.number().positive().default(0.01),

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
  /** #5 automação — usa a tolerância de slippage POR DEX (seed do Dune) no lugar do global. Default false (observe-first). */
  SLIPPAGE_PER_DEX_ENABLED: boolEnv(false),
  /** Cap de % da liquidez do pool em swap (proteção contra over-trade). */
  POOL_LIQUIDITY_CAP_PCT: z.coerce.number().min(0.01).max(0.5).default(0.1),
  /** Gas estimate em USD pra liquidations (Base ~ $0.20-0.50, ajustar via observação). */
  GAS_COST_USD_ESTIMATE: z.coerce.number().positive().default(0.5),
  /**
   * OIE Etapa B — gate opt-in por EV ajustado a OEV (prioriza Morpho).
   * Vazio/ausente = desligado (comportamento inalterado; só loga o score). Quando setado,
   * descarta liquidações cujo EV REALISTA pós-OEV < este valor (USD) ANTES de gastar gas.
   * Como Aave/Compound/Moonwell na Base têm OEV capture (~80-99%), elas tendem a cair no
   * gate e o bot foca em Morpho Blue (recapture 0). Ver docs/refs/competitive-landscape.md.
   */
  MIN_OPPORTUNITY_EV_USD: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().optional(),
  ),

  // ─── OIE Etapa C — thresholds adaptativos (auto-ajuste por observação) ───
  /**
   * Liga o auto-ajuste. Default `false` = só COMPUTA + LOGA o que ele faria (você vê o
   * loop de feedback sem mudar comportamento). `true` = injeta MIN_OPPORTUNITY_EV_USD
   * adaptativo no gate. Adapta dos sinais de observação do ledger (DRY_RUN-safe).
   */
  ADAPTIVE_THRESHOLDS_ENABLED: boolEnv(false),
  /** Intervalo de recálculo (s). Default 600 (10min). */
  ADAPTIVE_RECALC_INTERVAL_SEC: z.coerce.number().int().positive().default(600),
  /** Janela de observação pro recálculo (dias). Default 7. */
  ADAPTIVE_WINDOW_DAYS: z.coerce.number().positive().default(7),

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
  AUTO_KILL_SWITCH_ENABLED: boolEnv(true),
  /**
   * Trava-mestra de segurança. Default `true` = TRAVADO (fail-safe). Pra rodar em `mainnet`
   * (capital real), o operador TEM que setar explicitamente `KILL_SWITCH=false` no .env — senão
   * o boot é RECUSADO (ver superRefine abaixo). Não afeta dryrun/testnet (lá não há capital real).
   * É a "trava explícita" pré-mainnet: nunca liga capital real por esquecimento de config. */
  KILL_SWITCH: boolEnv(true),

  // ─── Cooldown após N falhas seguidas (gap crítico #2) ───
  /** Número de falhas CONSECUTIVAS pra ativar cooldown automático.
   *  Sucesso reseta o contador. Falhas pre-dispatch (gate simulação) NÃO contam. */
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(3),
  /** Duração do cooldown em segundos quando MAX_CONSECUTIVE_FAILURES é atingido.
   *  Default 5min — tempo pra calibração entre tentativas. */
  COOLDOWN_DURATION_SEC: z.coerce.number().int().positive().default(300),
  /** #4 automação — injeta o cooldown ADAPTATIVO (backoff por cooldowns repetidos). Default false → observa "o que faria". */
  ADAPTIVE_COOLDOWN_ENABLED: boolEnv(false),
  /** Teto do cooldown adaptativo (segundos). Default 30min — trava contra backoff descontrolado. */
  COOLDOWN_MAX_SEC: z.coerce.number().int().positive().default(1800),

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
  BLOCK_DISPATCH_ON_CRITICAL_GAS: boolEnv(true),

  // ─── Stale position re-check (gap crítico #8) ───
  /** Se true, antes do dispatch real, faz 1 chamada RPC extra pra confirmar que
   *  borrower AINDA é liquidatable. Reduz gas perdido por race com outros bots.
   *  Custo: +50ms latência por dispatch. Em dryrun não tem efeito. */
  STALE_CHECK_ENABLED: boolEnv(true),

  // ─── EIP-1559 gas pricing (gap crítico #5) ───
  /** Priority fee (gorjeta sequencer) em gwei. Default 0.001 — Base não tem MEV-Boost,
   *  sequencer Coinbase aceita gorjetas mínimas (FCFS por timestamp).
   *  Aumentar pra 0.01-0.1 se observar tx ficando pendente OR pra ganhar race em mainnet. */
  GAS_PRIORITY_FEE_GWEI: z.coerce.number().positive().default(0.001),
  /** Multiplier do baseFee pra calcular maxFee. Default 2x absorve spike de 100% no
   *  baseFee entre blocos. Aumentar pra 3-5x em mainnet com volatilidade de gas alta. */
  GAS_MAX_FEE_MULTIPLIER: z.coerce.number().positive().default(2),

  // ─── Alerting (event bus + webhooks) ───
  /** URL do webhook Discord pra alertas formatados (embeds). Vazio = sink Discord não ativa.
   *  Criar webhook em canal SEU privado: Server > Integrations > Webhooks > New */
  DISCORD_WEBHOOK_URL: optionalUrl(),
  /** URL genérica pra POST JSON dos eventos crus (sem formatação Discord).
   *  Útil pra Telegram bot, mini server local, n8n, futuro WebSocket gateway. */
  GENERIC_WEBHOOK_URL: optionalUrl(),
  /** Segredo compartilhado enviado no header `x-zeus-secret` de cada POST (autentica no /api/ingest
   *  do ZEUS Command). DEVE bater com `ZEUS_WEBHOOK_SECRET` no Vercel. Sem ele, o ingest barra (401)
   *  se exigir secret, ou fica aberto se não. */
  GENERIC_WEBHOOK_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Filtro de severidades pro Discord (comma-separated). Default: 'warn,critical' (sem info pra evitar spam).
   *  Override pra 'info,warn,critical' se quiser ver TUDO durante calibração. */
  DISCORD_SEVERITIES: z.string().default('warn,critical'),
  /** Filtro de severidades pro generic webhook. Default: 'info,warn,critical' (envia tudo). */
  GENERIC_SEVERITIES: z.string().default('info,warn,critical'),
  // ── Controle remoto de execução (toggle do painel via Supabase engine_control) ──
  /** URL base do Supabase (REST) pra LER o toggle de execução. Sem ela → execução TRAVADA (fail-safe). */
  SUPABASE_URL: optionalUrl(),
  /** Chave Supabase (anon/service) pro REST read do engine_control. Sem ela → TRAVADA (fail-safe). */
  SUPABASE_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Motor desta instância na tabela engine_control. Default 'motor1' (liquidator). */
  ENGINE_CONTROL_MOTOR: z.string().default('motor1'),
  /** Cadência do poll do toggle (segundos). Default 15. */
  ENGINE_CONTROL_POLL_SEC: z.coerce.number().positive().default(15),

  // ─── Bribe (V7) — opt-in pra liquidator competir via bundle privado ───
  /** Se true, usa funções v7 `*WithBribe` em vez das v6. Default false (mantém v6).
   *  Em mainnet competitivo (Ethereum L1), ativar pra ter chance contra searchers Tier-1.
   *  Em Base/Arb/OP FCFS, bribe ajuda mas não é vital. */
  BRIBE_ENABLED: boolEnv(false),
  /** Hard cap em bps. Bribe nunca passa disso. Default 9500 = 95%. */
  BRIBE_HARD_CAP_BPS: z.coerce.number().int().min(100).max(9_900).default(9_500),
  /** Fee tier UniV3 default pro pool profitToken/WETH no swap inline (500 = 0.05%). */
  BRIBE_SWAP_FEE_TIER: z.coerce.number().int().positive().default(500),
  /** Slippage default no swap inline (bps). */
  BRIBE_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(1_000).default(50),
  /** Profit USD mínimo pra entrar em leilão de bribe. Liquidations geram ticket >$5
   *  então threshold pode ser mais agressivo que backrun. Default $5. */
  BRIBE_MIN_PROFIT_USD: z.coerce.number().positive().default(5),
  /** % do profit pra bribe quando BRIBE_ENABLED=true. Calibrar via observação.
   *  Default 50% — equilibrado entre competir e preservar profit. */
  BRIBE_DEFAULT_BPS: z.coerce.number().int().min(100).max(9_500).default(5_000),

  // ─── Bribe competitor-aware com teto de lucro (Motor 1 — priority fee dinâmico) ───
  /** Auto-ajusta o priority fee (o bribe na Base) pra ganhar corridas, SEMPRE limitado pelo lucro
   *  da oportunidade (nunca prejuízo). Opt-in — default false (usa o priority fee estático). */
  COMPETITIVE_BRIBE_ENABLED: z.coerce.boolean().default(false),
  /** Percentil de mercado alvo pra ganhar a corrida. Default 'p75'. */
  BRIBE_TARGET_PERCENTILE: z.enum(['p50', 'p75', 'p95']).default('p75'),
  /** Teto RÍGIDO de priority fee (gwei) — sanidade extra além do teto de lucro. Default 5. */
  MAX_BRIBE_GWEI: z.coerce.number().positive().default(5),

  // ─── Bundle relays (V7) ───
  /** URL Flashbots Protect (Ethereum L1 ou compatible). Vazio = sem Flashbots. */
  FLASHBOTS_RELAY_URL: optionalUrl(),
  /** Signing key pra reputation tracking no Flashbots. */
  FLASHBOTS_AUTH_KEY: optionalString(),
  /** URL FastLane Atlas (placeholder até integrar UserOp encoding). */
  ATLAS_RELAY_URL: optionalUrl(),
  /** URL Blocknative MEV-Share / Private RPC. */
  BLOCKNATIVE_RELAY_URL: optionalUrl(),
  /** Timeout em ms pra cada relay submit. */
  RELAY_TIMEOUT_MS: z.coerce.number().int().positive().default(4_000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ─── Health Server (Item 12 H8+H11) ───
  /** Habilita HTTP health server (/healthz + /readyz). Default true em prod. */
  HEALTH_SERVER_ENABLED: boolEnv(true),
  /** Porta de bind. Liquidator default 7880. */
  HEALTH_SERVER_PORT: z.coerce.number().int().min(1024).max(65535).default(7880),
  /** Host bind. '127.0.0.1' (loopback) pra dev local, '0.0.0.0' pra expor externamente. */
  HEALTH_SERVER_HOST: z.string().default('127.0.0.1'),

  // ─── PnL Reporter (Item 10 P7 — daily digest pra Discord) ───
  /** Habilita PnL daily reporter. Default true mas só envia se PNL_REPORTER_WEBHOOK_URL configurado. */
  PNL_REPORTER_ENABLED: boolEnv(true),
  /** Discord webhook dedicado pro PnL reporter (pode ser igual DISCORD_WEBHOOK_URL). */
  PNL_REPORTER_WEBHOOK_URL: optionalUrl(),
  /** Hora UTC pra disparar daily digest. Default 12 (meio-dia UTC). */
  PNL_REPORTER_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(12),

  // ─── Competitor Reporter (Item 5 F9 — weekly digest) ───
  /** Habilita competitor weekly reporter. */
  COMPETITOR_REPORTER_ENABLED: boolEnv(true),
  /** Discord webhook pro competitor reporter (pode ser o mesmo). */
  COMPETITOR_REPORTER_WEBHOOK_URL: optionalUrl(),
  /** Dia da semana (0=domingo, 1=segunda, ..., 6=sábado). Default 1 (segunda). */
  COMPETITOR_REPORTER_WEEKDAY_UTC: z.coerce.number().int().min(0).max(6).default(1),
  /** Hora UTC pra disparar weekly digest. Default 14h UTC. */
  COMPETITOR_REPORTER_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(14),

  // ─── Oracle Staleness Check (Grupo B) ───
  /** Habilita gate pre-dispatch de oracle staleness. */
  ORACLE_STALENESS_CHECK_ENABLED: boolEnv(true),
  /** Threshold default em segundos. Chainlink Base ETH/USD update a cada ~1h. */
  ORACLE_STALENESS_THRESHOLD_SEC: z.coerce.number().int().min(60).max(86400).default(3600),

  // ─── Pause Detector (Grupo B) ───
  /** Habilita gate pre-dispatch contra Aave Pool.paused / Comet.isAbsorbPaused. */
  PAUSE_DETECTOR_ENABLED: boolEnv(true),
  /** TTL do cache de pause state em blocos (~12s/bloco em Base). Default 3. */
  PAUSE_DETECTOR_CACHE_BLOCKS: z.coerce.number().int().min(1).max(20).default(3),

  // ─── Multi-collateral Evaluation (Grupo B) ───
  /**
   * Avalia TODOS pares (collateral_i, debt_j) por borrower em vez de top-1 por wei.
   * Calculator roda N vezes mas pipeline escolhe maior profit. Resolve gap M-01 do audit
   * (26/28 at-risk hoje não resolvem por usar top-1).
   */
  MULTI_COLLATERAL_EVAL_ENABLED: boolEnv(true),

  // ─── Multi-hop Swaps (Grupo B) ───
  /**
   * Habilita rotas 2-hop (collateral → WETH/USDC → debt) além de single-hop.
   * Resolve gap "pool direto raso" — pares exóticos costumam ter mais liquidez
   * via intermediate. Custo: +9 RPC calls por amount testado.
   */
  MULTI_HOP_SWAPS_ENABLED: boolEnv(true),

  // ─── Failure Reporter (Item 4 A8 — weekly Markdown digest) ───
  /** Habilita weekly failure digest. */
  FAILURE_REPORTER_ENABLED: boolEnv(true),
  /** Discord webhook pro failure reporter. */
  FAILURE_REPORTER_WEBHOOK_URL: optionalUrl(),
  /** Dia da semana (0=domingo, 1=segunda, ..., 6=sábado). Default 1 (segunda). */
  FAILURE_REPORTER_WEEKDAY_UTC: z.coerce.number().int().min(0).max(6).default(1),
  /** Hora UTC pra disparar. Default 15h UTC (1h depois do competitor). */
  FAILURE_REPORTER_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(15),
}).superRefine((cfg, ctx) => {
  // TRAVA-MESTRA: mainnet (capital real) exige KILL_SWITCH=false EXPLÍCITO. Default true → recusa
  // o boot. Impede ligar capital real por esquecimento. dryrun/testnet não têm capital real → livres.
  if (cfg.LIQUIDATOR_MODE === 'mainnet' && cfg.KILL_SWITCH !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['KILL_SWITCH'],
      message:
        'KILL_SWITCH=true bloqueia LIQUIDATOR_MODE=mainnet (capital real). Pra liberar, set explicitamente KILL_SWITCH=false no .env.',
    });
  }
  // Wallet-pool: ligado SEM seed-mestre → recusa (fail-safe; não derivar de seed vazia/lixo).
  if (cfg.WALLET_POOL_ENABLED && !cfg.WALLET_POOL_MNEMONIC) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WALLET_POOL_MNEMONIC'],
      message: 'WALLET_POOL_ENABLED=true exige WALLET_POOL_MNEMONIC (seed-mestre BIP-39 dedicada).',
    });
  }
  // Top-up de gás coerente: alvo nunca menor que o gatilho.
  if (cfg.WALLET_POOL_GAS_TARGET_ETH < cfg.WALLET_POOL_GAS_MIN_ETH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WALLET_POOL_GAS_TARGET_ETH'],
      message: 'WALLET_POOL_GAS_TARGET_ETH deve ser ≥ WALLET_POOL_GAS_MIN_ETH.',
    });
  }
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
