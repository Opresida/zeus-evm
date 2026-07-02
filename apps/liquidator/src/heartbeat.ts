/**
 * Monta o payload do `zeus.heartbeat` (item 2/3/4 da cobertura do Frontend).
 *
 * Função PURA (sem I/O) → testável sem subir o app. O `index.ts` chama isto no loop de métricas
 * reusando valores JÁ coletados (gás, uptime, pause, PnL, market-bribe, drift, pulso do radar).
 *
 * O heartbeat é a ÚNICA ponte do estado-pulso pro painel: vira UPSERT em `service_status` (1 linha
 * por serviço), então não inunda a tabela `events`. Carrega: gás-agora, uptime, estado real (autoPaused),
 * stats por motor, pulso do radar (discovery) e agregados de inteligência (intel).
 */

import type {
  HeartbeatCompetitor,
  HeartbeatCooldown,
  HeartbeatDiscovery,
  HeartbeatEdgePair,
  HeartbeatHealth,
  HeartbeatIntel,
  HeartbeatKillSwitch,
  HeartbeatLatency,
  HeartbeatReorgs,
  HeartbeatCompetition,
  HeartbeatStrategyStat,
  VettedEntry,
  ZeusHeartbeatEvent,
} from '@zeus-evm/execution-utils';

export interface HeartbeatInput {
  service: string;
  chain: string;
  mode: 'dryrun' | 'testnet' | 'mainnet';
  /** ISO da emissão (injetado pra a função ser pura/testável). */
  timestamp: string;
  uptimeSec: number;
  gasReserveEth?: number;
  gasReserveUsd?: number;
  /** Estado REAL de execução (true = pausado/travado). */
  autoPaused: boolean;
  /** Identificador do motor ('motor1' | 'motor2' | 'motor3'). */
  motorTag: string;
  /** Nº cumulativo de operações (despachadas + simuladas). */
  ops: number;
  /** PnL líquido 24h (USD). */
  netPnl24hUsd: number;
  /** Agregado por estratégia (clássica × pré-liq × filler) — tela "Estratégias". */
  strategyStats?: HeartbeatStrategyStat[];
  /** Universo vetado por colateral (porteiro M1) — tela "Tokens". */
  vettedUniverse?: VettedEntry[];
  /** Estado do filtro de tokens por motor (badge na tela "Tokens"). */
  vettingEnforce?: { motor1?: boolean; motor2?: boolean };
  /** ISO do último re-vet (freshness "re-vet há Xs" na tela "Tokens"). */
  vettingRevetAt?: string;
  /** Pulso do radar de descoberta — omitido por motores sem discovery. */
  discovery?: HeartbeatDiscovery;
  /** Agregados de inteligência — omitido quando não há dados. */
  intel?: HeartbeatIntel;
  // ── Fase 2 — blocos extras (todos opcionais; omitidos quando vazios) ──
  health?: HeartbeatHealth;
  competitors?: HeartbeatCompetitor[];
  cooldowns?: HeartbeatCooldown[];
  killSwitch?: HeartbeatKillSwitch;
  edgePairs?: HeartbeatEdgePair[];
  latency?: HeartbeatLatency;
  reorgs?: HeartbeatReorgs;
  competition?: HeartbeatCompetition;
  errorMetrics?: { failedOps: number; totalOps: number };
  /** Automações "vivas" Leva 3 (observe-first) — #9 calibração de gás + #7 quarentena de token. */
  liveAutomations?: {
    gasCalibration?: {
      samples: number;
      observedP50Usd: number;
      observedP95Usd: number;
      configuredUsd: number;
      driftPct: number;
      wouldAdjustToUsd: number;
      applied: boolean;
    };
    quarantine?: Array<{ token: string; symbol?: string; failures: number; wouldQuarantine: boolean }>;
  };
  /** Chave-mestra — "pacote de combate" do Motor 1 (espelha o do Motor 2; transparência no painel). */
  combatBundle?: {
    executionLive: boolean;
    adaptive: boolean;
    competitiveBribe: boolean;
    slippagePerDex?: boolean;
    walletPoolReady: number;
    walletPoolActive: boolean;
  };
}

/** Constrói o evento `zeus.heartbeat` a partir de valores já coletados pelo loop de métricas. */
export function buildHeartbeatPayload(i: HeartbeatInput): ZeusHeartbeatEvent {
  return {
    type: 'zeus.heartbeat',
    timestamp: i.timestamp,
    chain: i.chain,
    mode: i.mode,
    severity: 'info',
    service: i.service,
    uptimeSec: i.uptimeSec,
    gasReserveEth: i.gasReserveEth,
    gasReserveUsd: i.gasReserveUsd,
    autoPaused: i.autoPaused,
    motorStats: [{ tag: i.motorTag, ops: i.ops, netPnl24hUsd: i.netPnl24hUsd }],
    // Só inclui se houver dado — mantém o payload enxuto (intel/discovery são opcionais no tipo).
    ...(i.strategyStats && i.strategyStats.length ? { strategyStats: i.strategyStats } : {}),
    ...(i.vettedUniverse && i.vettedUniverse.length ? { vettedUniverse: i.vettedUniverse } : {}),
    ...(i.vettingEnforce ? { vettingEnforce: i.vettingEnforce } : {}),
    ...(i.vettingRevetAt ? { vettingRevetAt: i.vettingRevetAt } : {}),
    ...(i.discovery ? { discovery: i.discovery } : {}),
    ...(i.intel ? { intel: i.intel } : {}),
    ...(i.health && i.health.components.length ? { health: i.health } : {}),
    ...(i.competitors && i.competitors.length ? { competitors: i.competitors } : {}),
    ...(i.cooldowns && i.cooldowns.length ? { cooldowns: i.cooldowns } : {}),
    ...(i.killSwitch ? { killSwitch: i.killSwitch } : {}),
    ...(i.edgePairs && i.edgePairs.length ? { edgePairs: i.edgePairs } : {}),
    ...(i.latency && i.latency.samples > 0 ? { latency: i.latency } : {}),
    ...(i.reorgs ? { reorgs: i.reorgs } : {}),
    ...(i.competition ? { competition: i.competition } : {}),
    ...(i.errorMetrics ? { errorMetrics: i.errorMetrics } : {}),
    ...(i.combatBundle ? { combatBundle: i.combatBundle } : {}),
    ...(i.liveAutomations ? { liveAutomations: i.liveAutomations } : {}),
  };
}

/**
 * Filtra um `HeartbeatIntel` pra só conter campos definidos — evita mandar `undefined` no JSON.
 * Retorna `undefined` se nada sobrou (aí o heartbeat omite o bloco `intel`).
 */
export function compactIntel(intel: HeartbeatIntel): HeartbeatIntel | undefined {
  const out: Record<string, number> = {};
  // Só campos NUMÉRICOS finitos (flags string/bool entram por spread fora daqui).
  for (const [k, v] of Object.entries(intel)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as HeartbeatIntel) : undefined;
}
