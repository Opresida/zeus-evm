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

  const rows = events.map(toRow);
  const { error } = await sb.from("events").insert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // fan-out de notificações (não bloqueia a resposta em caso de erro)
  for (const e of events) {
    if (isAlertable(e)) {
      await fanoutPush(e);
      await sendEmail(e);
    }
  }

  return NextResponse.json({ ok: true, inserted: rows.length });
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "zeus-command/ingest" });
}
