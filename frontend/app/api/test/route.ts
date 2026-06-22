import { NextResponse } from "next/server";
import type { ZeusEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Injeta um evento de exemplo no pipeline (POSTa pra /api/ingest).
 * Uso: GET /api/test?type=tx.confirmed  — facilita validar realtime + push.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "tx.confirmed";

  const samples: Record<string, ZeusEvent> = {
    "tx.confirmed": {
      type: "tx.confirmed",
      severity: "info",
      chain: "base",
      mode: "mainnet",
      protocol: "Morpho Blue",
      pair: "cbETH/WETH",
      txHash: "0x" + Math.random().toString(16).slice(2, 10) + "test",
      netProfitUsd: 600 + Math.round(Math.random() * 200),
      gasCostUsd: 5.1,
      profitDeltaBps: -8,
      blockNumber: 20000000,
    },
    "gas.alert": {
      type: "gas.alert",
      severity: "critical",
      chain: "base",
      mode: "mainnet",
      account: "0xExecutor",
      balanceEth: 0.18,
      balanceUsd: 590,
      status: "low",
    },
    "zeus.heartbeat": {
      type: "zeus.heartbeat",
      severity: "info",
      chain: "base",
      mode: "mainnet",
      service: "liquidator",
      gasReserveEth: 0.412,
      gasReserveUsd: 1340,
      uptimeSec: 287400,
      adaptiveMinEvUsd: 4.2,
      autoPaused: false,
    },
  };

  const evt = samples[type] || samples["tx.confirmed"];
  evt.timestamp = new Date().toISOString();

  const origin = url.origin;
  const res = await fetch(`${origin}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.ZEUS_WEBHOOK_SECRET ? { "x-zeus-secret": process.env.ZEUS_WEBHOOK_SECRET } : {}),
    },
    body: JSON.stringify(evt),
  });
  const out = await res.json().catch(() => ({}));
  return NextResponse.json({ sent: evt, ingest: out });
}
