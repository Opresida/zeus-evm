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
    ...(i.discovery ? { discovery: i.discovery } : {}),
    ...(i.intel ? { intel: i.intel } : {}),
    ...(i.health && i.health.components.length ? { health: i.health } : {}),
    ...(i.competitors && i.competitors.length ? { competitors: i.competitors } : {}),
    ...(i.cooldowns && i.cooldowns.length ? { cooldowns: i.cooldowns } : {}),
    ...(i.killSwitch ? { killSwitch: i.killSwitch } : {}),
    ...(i.edgePairs && i.edgePairs.length ? { edgePairs: i.edgePairs } : {}),
    ...(i.latency && i.latency.samples > 0 ? { latency: i.latency } : {}),
    ...(i.reorgs ? { reorgs: i.reorgs } : {}),
  };
}

/**
 * Filtra um `HeartbeatIntel` pra só conter campos definidos — evita mandar `undefined` no JSON.
 * Retorna `undefined` se nada sobrou (aí o heartbeat omite o bloco `intel`).
 */
export function compactIntel(intel: HeartbeatIntel): HeartbeatIntel | undefined {
  const out: HeartbeatIntel = {};
  for (const [k, v] of Object.entries(intel) as [keyof HeartbeatIntel, number | undefined][]) {
    if (v != null && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
