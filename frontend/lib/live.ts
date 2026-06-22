import { usd } from "./viewModel";
import { uptimeFromSec } from "./viewModel";
import type { EventRow, LiveSnapshot, TxRow, ZeusEvent } from "./types";

const TX_TYPES = new Set(["tx.confirmed", "tx.reverted_on_chain", "tx.reverted_pre_dispatch"]);

function hhmm(ts: string) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function ago(ts: string) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  return sec < 60 ? sec + "s" : sec < 3600 ? Math.floor(sec / 60) + "m" : Math.floor(sec / 3600) + "h";
}
function colorFor(type: string): string {
  if (type === "tx.confirmed" || type === "gas.recovered" || type.endsWith(".boot")) return "var(--green)";
  if (type.startsWith("tx.reverted") || type === "gas.alert" || type.includes("kill_switch")) return "var(--red)";
  if (type.startsWith("backrun") || type === "whale.swap_detected") return "var(--cyan)";
  return "var(--gold)";
}

function rowToTx(r: EventRow): TxRow {
  const st: TxRow["st"] = r.type === "tx.confirmed" ? "ok" : r.type === "tx.reverted_on_chain" ? "rev" : "pre";
  const net = r.net_profit_usd ?? (st === "rev" ? -(r.gas_usd ?? 0) : 0);
  return {
    st,
    protocol: r.protocol || "—",
    pair: r.pair || (r.payload?.pair as string) || "—",
    net,
    gas: r.gas_usd ?? 0,
    drift: r.profit_delta_bps ?? 0,
    hash: r.tx_hash,
    mode: (r.mode || "main").slice(0, 4),
    time: hhmm(r.ts),
    reason: (r.payload?.reason as string) || undefined,
  };
}

function tickerText(r: EventRow): string {
  const p = r.protocol ? " · " + r.protocol : "";
  if (r.type === "tx.confirmed") return `tx.confirmed${p} · ${usd(r.net_profit_usd ?? 0)} net`;
  if (r.type === "tx.reverted_on_chain") return `tx.reverted_on_chain${p} · −$${(r.gas_usd ?? 0).toFixed(2)} gás`;
  if (r.type === "backrun.dispatched") return `backrun.dispatched${r.pair ? " · " + r.pair : ""}`;
  if (r.type === "whale.swap_detected") return `whale.swap_detected${p}`;
  const ev = r.payload as ZeusEvent;
  return `${r.type}${p}${ev?.reason ? " · " + ev.reason : ""}`;
}

/** Deriva o snapshot ao vivo a partir das linhas de eventos (mais recente primeiro). */
export function deriveSnapshot(rows: EventRow[]): LiveSnapshot {
  if (!rows.length) return {};
  const snap: LiveSnapshot = {};

  // ----- transações -----
  const txRows = rows.filter((r) => TX_TYPES.has(r.type)).map(rowToTx);
  if (txRows.length) {
    snap.txRows = txRows;
    snap.txCounts = {
      all: txRows.length,
      ok: txRows.filter((t) => t.st === "ok").length,
      rev: txRows.filter((t) => t.st === "rev").length,
      pre: txRows.filter((t) => t.st === "pre").length,
    };
  }

  // ----- ticker (últimos 6 eventos relevantes) -----
  const tickerSrc = rows
    .filter((r) => r.type.startsWith("tx.") || r.type.startsWith("backrun") || r.type === "whale.swap_detected")
    .slice(0, 6);
  if (tickerSrc.length) {
    snap.ticker = tickerSrc.map((r) => ({ color: colorFor(r.type), text: tickerText(r), time: ago(r.ts) }));
  }

  // ----- KPIs do dia -----
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const today = rows.filter((r) => new Date(r.ts) >= startOfDay && (r.type === "tx.confirmed" || r.type === "tx.reverted_on_chain"));
  if (today.length) {
    const ok = today.filter((r) => r.type === "tx.confirmed").length;
    const fail = today.length - ok;
    const net = today.reduce((acc, r) => acc + (r.net_profit_usd ?? (r.type === "tx.reverted_on_chain" ? -(r.gas_usd ?? 0) : 0)), 0);
    snap.kpiToday = net;
    snap.kpiTodayTx = today.length;
    snap.kpiOk = ok;
    snap.kpiFail = fail;
    snap.kpiWinRate = ((ok / today.length) * 100).toFixed(1) + "%";
  }

  // ----- estado a partir do último heartbeat / gás -----
  const hb = rows.find((r) => r.type === "zeus.heartbeat");
  if (hb) {
    const p = hb.payload as ZeusEvent;
    if (p.gasReserveEth != null) snap.gasEth = p.gasReserveEth.toFixed(3);
    if (p.gasReserveUsd != null) snap.gasUsd = "$" + p.gasReserveUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p.adaptiveMinEvUsd != null) snap.adaptiveEv = "$" + p.adaptiveMinEvUsd.toFixed(2);
    if (p.autoPaused != null) snap.botStatus = p.autoPaused ? "PAUSED" : "RUNNING";
  }
  const gasEvt = rows.find((r) => r.type === "gas.alert" || r.type === "gas.recovered");
  if (gasEvt) {
    const p = gasEvt.payload as ZeusEvent;
    if (snap.gasEth == null && p.balanceEth != null) snap.gasEth = p.balanceEth.toFixed(3);
    if (snap.gasUsd == null && p.balanceUsd != null) snap.gasUsd = "$" + p.balanceUsd.toFixed(2);
  }

  // ----- log do sistema -----
  const sysTypes = new Set([
    "zeus.heartbeat",
    "failure.cooldown_activated",
    "failure.cooldown_expired",
    "gas.alert",
    "gas.recovered",
    "pnl.kill_switch_triggered",
    "liquidator.boot",
    "liquidator.shutdown",
  ]);
  const sys = rows.filter((r) => sysTypes.has(r.type)).slice(0, 7);
  if (sys.length) {
    snap.eventLog = sys.map((r) => {
      const p = r.payload as ZeusEvent;
      let text = (p?.reason as string) || "";
      if (r.type === "zeus.heartbeat" && p.uptimeSec != null)
        text = `Heartbeat ok · gás ${p.gasReserveEth?.toFixed(3) ?? "?"} ETH · uptime ${uptimeFromSec(p.uptimeSec)}`;
      else if (r.type === "gas.alert") text = text || `Gás baixo · ${p.balanceEth?.toFixed(3) ?? "?"} ETH`;
      else if (r.type.includes("cooldown")) text = text || `Cooldown · ${p.consecutiveFailures ?? "?"} falhas · ${p.cooldownSec ?? "?"}s`;
      else if (r.type.includes("kill_switch")) text = text || `Kill switch · perda 24h ${usd(p.loss24hUsd ?? 0)}`;
      return { time: hhmm(r.ts), color: colorFor(r.type), type: r.type, text: text || r.type };
    });
  }

  return snap;
}
