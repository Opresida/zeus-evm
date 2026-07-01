import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabaseServer";
import { fanoutPush, sendEmail, isAlertable } from "@/lib/notify";
import type { ZeusEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STRATEGY_KEYS = new Set(["classic-liq", "pre-liq", "filler"]);
const finNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Sanea `strategyStats` do heartbeat ANTES de gravar no jsonb (defesa de fronteira).
 * Mesmo a rota sendo gated por x-zeus-secret, não confiamos cego no corpo: rejeita formato
 * errado, descarta chave fora do allowlist, força número finito e limita o tamanho do array.
 */
function sanitizeStrategyStats(raw: unknown) {
  if (!Array.isArray(raw)) return null;
  const out = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .filter((s) => STRATEGY_KEYS.has(s.strategy as string))
    .slice(0, 8)
    .map((s) => ({
      strategy: s.strategy as string,
      candidates24h: Math.max(0, finNum(s.candidates24h)),
      candidateProfitUsd24h: finNum(s.candidateProfitUsd24h),
      executed24h: Math.max(0, finNum(s.executed24h)),
      netUsd24h: finNum(s.netUsd24h),
    }));
  return out.length ? out : null;
}

const MOTOR_KEYS = new Set(["motor1", "motor2"]);
const VERDICT_KEYS = new Set(["pass", "reject"]);

/** Sanea `vettedUniverse` do heartbeat ANTES do jsonb (mesma defesa de fronteira do strategyStats). */
function sanitizeCompetition(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const topBuilders = (Array.isArray(c.topBuilders) ? c.topBuilders : [])
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .slice(0, 5)
    .map((b) => ({
      alias: String(b.alias ?? "?").slice(0, 40),
      blocks: Math.max(0, finNum(b.blocks)),
      competitorTxs: Math.max(0, finNum(b.competitorTxs)),
      ourTxs: Math.max(0, finNum(b.ourTxs)),
    }));
  const p = (c.position ?? {}) as Record<string, unknown>;
  const position = {
    samples: Math.max(0, finNum(p.samples)),
    bottom10pctPct: Math.max(0, Math.min(100, finNum(p.bottom10pctPct))),
    top10pctPct: Math.max(0, Math.min(100, finNum(p.top10pctPct))),
    avgRelative: Math.max(0, Math.min(1, finNum(p.avgRelative))),
  };
  return topBuilders.length || position.samples ? { topBuilders, position } : null;
}

function sanitizeVettedUniverse(raw: unknown) {
  if (!Array.isArray(raw)) return null;
  const out = raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .filter((t) => MOTOR_KEYS.has(t.motor as string) && VERDICT_KEYS.has(t.verdict as string))
    .slice(0, 200)
    .map((t) => ({
      token: String(t.token ?? "0x"),
      symbol: String(t.symbol ?? "?").slice(0, 16),
      motor: t.motor as string,
      verdict: t.verdict as string,
      reason: String(t.reason ?? "").slice(0, 200),
      exitDex: t.exitDex != null ? String(t.exitDex).slice(0, 40) : null,
      liquidityUsd: Math.max(0, finNum(t.liquidityUsd)),
      locked: Boolean(t.locked),
      lockPct: Math.max(0, Math.min(100, finNum(t.lockPct))),
      locker: t.locker != null ? String(t.locker).slice(0, 40) : null,
      unlockIso: typeof t.unlockIso === "string" ? t.unlockIso.slice(0, 40) : null,
      partial: Boolean(t.partial), // verdict feito com dados incompletos (fail-safe) → selo no painel
    }));
  return out.length ? out : null;
}

/** Mapeia um ZeusEvent para colunas da tabela `events`. */
function toRow(e: ZeusEvent) {
  return {
    type: String(e.type ?? "unknown"),
    severity: (e.severity as string) ?? "info",
    ts: e.timestamp ?? new Date().toISOString(),
    chain: e.chain ?? null,
    mode: (e.mode as string) ?? null,
    protocol: e.protocol ?? null,
    pair: (e.pair as string) ?? null,
    tx_hash: e.txHash ?? (e.ourTxHash as string) ?? null,
    borrower: e.borrower ?? null,
    profit_usd: e.profitUsd ?? null,
    gas_usd: e.gasCostUsd ?? e.gasUsd ?? e.gasUsdLost ?? null,
    net_profit_usd: e.netProfitUsd ?? e.realizedNetUsd ?? null,
    profit_delta_bps: e.profitDeltaBps ?? null,
    block_number: e.blockNumber ?? null,
    payload: e,
  };
}

export async function POST(req: Request) {
  // ----- auth: header x-zeus-secret -----
  const secret = process.env.ZEUS_WEBHOOK_SECRET;
  if (secret) {
    const got = req.headers.get("x-zeus-secret");
    if (got !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // aceita 1 evento ou um array
  const events: ZeusEvent[] = Array.isArray(body) ? (body as ZeusEvent[]) : [body as ZeusEvent];
  if (!events.length) return NextResponse.json({ ok: true, inserted: 0 });

  const sb = getServiceSupabase();
  if (!sb) return NextResponse.json({ error: "supabase not configured" }, { status: 503 });

  // Heartbeats (~30s) NÃO vão pra `events` (inundariam) — viram UPSERT em service_status (1 linha/serviço).
  const heartbeats = events.filter((e) => String(e.type) === "zeus.heartbeat");
  // wallet.snapshot (Fase 2b) → tabela própria `wallet_snapshots` (série temporal, fora do event-log).
  const walletSnaps = events.filter((e) => String(e.type) === "wallet.snapshot");
  const businessEvents = events.filter(
    (e) => String(e.type) !== "zeus.heartbeat" && String(e.type) !== "wallet.snapshot",
  );

  if (heartbeats.length) {
    const statusRows = heartbeats.map((e) => ({
      service: String(e.service ?? "unknown"),
      chain: e.chain ?? null,
      mode: (e.mode as string) ?? null,
      uptime_sec: e.uptimeSec ?? null,
      gas_reserve_eth: e.gasReserveEth ?? null,
      gas_reserve_usd: e.gasReserveUsd ?? null,
      adaptive_min_ev_usd: e.adaptiveMinEvUsd ?? null,
      auto_paused: e.autoPaused ?? null,
      motor_stats: e.motorStats ?? null,
      strategy_stats: sanitizeStrategyStats(e.strategyStats), // comparativo por estratégia (saneado na fronteira)
      vetted_universe: sanitizeVettedUniverse(e.vettedUniverse), // porteiro de tokens (saneado na fronteira)
      vetting_enforce:
        e.vettingEnforce && typeof e.vettingEnforce === "object"
          ? { motor1: Boolean((e.vettingEnforce as Record<string, unknown>).motor1), motor2: Boolean((e.vettingEnforce as Record<string, unknown>).motor2) }
          : null,
      vetting_revet_at: typeof e.vettingRevetAt === "string" ? e.vettingRevetAt : null,
      discovery: e.discovery ?? null, // pulso do radar (item 2)
      intel: e.intel ?? null, // agregados de inteligência (item 3)
      // Fase 2 — blocos extras (jsonb), só presentes no heartbeat que os trouxe (liquidator/mis).
      health: e.health ?? null,
      competitors: e.competitors ?? null,
      edge_pairs: e.edgePairs ?? null,
      cooldowns: e.cooldowns ?? null,
      kill_switch: e.killSwitch ?? null,
      latency: e.latency ?? null, // Fase 2b — p50/p95 de dispatch
      reorgs: e.reorgs ?? null, // Motor 1 — resiliência de reorg + órfãs recuperadas
      competition: sanitizeCompetition(e.competition), // item 4 — builders dominantes + posição no bloco
      updated_at: e.timestamp ?? new Date().toISOString(),
    }));
    const { error: hbErr } = await sb.from("service_status").upsert(statusRows, { onConflict: "service" });
    if (hbErr) return NextResponse.json({ error: hbErr.message }, { status: 500 });
  }

  if (walletSnaps.length) {
    const snapRows = walletSnaps.map((e) => ({
      service: String(e.service ?? "liquidator"),
      chain: e.chain ?? null,
      ts: e.timestamp ?? new Date().toISOString(),
      balance_eth: (e.balanceEth as number) ?? null,
      balance_usd: (e.balanceUsd as number) ?? null,
    }));
    const { error: wsErr } = await sb.from("wallet_snapshots").insert(snapRows);
    if (wsErr) return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  let inserted = 0;
  if (businessEvents.length) {
    const rows = businessEvents.map(toRow);
    const { error } = await sb.from("events").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    inserted = rows.length;
  }

  // fan-out de notificações (heartbeat nunca alerta) — não bloqueia a resposta em caso de erro
  for (const e of businessEvents) {
    if (isAlertable(e)) {
      await fanoutPush(e);
      await sendEmail(e);
    }
  }

  return NextResponse.json({ ok: true, inserted, heartbeats: heartbeats.length });
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "zeus-command/ingest" });
}
