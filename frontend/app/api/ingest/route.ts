import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabaseServer";
import { fanoutPush, sendEmail, isAlertable } from "@/lib/notify";
import type { ZeusEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      strategy_stats: e.strategyStats ?? null, // comparativo por estratégia (tela "Estratégias")
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
