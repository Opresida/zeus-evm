import { usd } from "./viewModel";
import { uptimeFromSec } from "./viewModel";
import type { EventRow, LiveSnapshot, ServiceStatusRow, TxRow, ZeusEvent } from "./types";

const TX_TYPES = new Set(["tx.confirmed", "tx.reverted_on_chain", "tx.reverted_pre_dispatch"]);

/** Mapeia o `protocol` de um evento tx.* para o motor (item 4 — mini-cards). */
const MOTOR_BY_PROTOCOL: Record<string, string> = {
  "aave-v3": "motor1",
  "compound-v3": "motor1",
  "morpho-blue": "motor1",
  "moonwell": "motor1",
  arb: "motor2",
  backrun: "motor3",
};
const MOTOR_LABEL: Record<string, string> = {
  motor1: "M1 · Liquidações",
  motor2: "M2 · Arbitragem",
  motor3: "M3 · Backrun",
};
function motorOf(protocol: string | null): string | null {
  if (!protocol) return null;
  return MOTOR_BY_PROTOCOL[protocol] ?? (protocol.startsWith("backrun") ? "motor3" : null);
}

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

/** Deriva o snapshot ao vivo a partir dos eventos (mais recente primeiro) + status dos serviços. */
export function deriveSnapshot(rows: EventRow[], statuses: ServiceStatusRow[] = []): LiveSnapshot {
  if (!rows.length && !statuses.length) return {};
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

  // ----- estado ao vivo a partir do service_status (heartbeat por serviço) -----
  const byService = (s: string) => statuses.find((x) => x.service === s);
  // Gás: vem do serviço que segura a wallet financiada (liquidator); fallback = qualquer um com gás.
  const gasSvc = byService("liquidator") ?? statuses.find((s) => s.gas_reserve_eth != null);
  if (gasSvc?.gas_reserve_eth != null) snap.gasEth = gasSvc.gas_reserve_eth.toFixed(3);
  if (gasSvc?.gas_reserve_usd != null)
    snap.gasUsd = "$" + gasSvc.gas_reserve_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // EV adaptativo: do Motor 2 (mis-scanner).
  const mis = byService("mis-scanner");
  if (mis?.adaptive_min_ev_usd != null) snap.adaptiveEv = "$" + mis.adaptive_min_ev_usd.toFixed(2);
  // Estado REAL do bot: o toggle do Motor 2 (auto_paused = travado). Senão, qualquer serviço pausado.
  if (mis?.auto_paused != null) snap.botStatus = mis.auto_paused ? "TRAVADO" : "RUNNING";
  else if (statuses.some((s) => s.auto_paused)) snap.botStatus = "PAUSED";

  const gasEvt = rows.find((r) => r.type === "gas.alert" || r.type === "gas.recovered");
  if (gasEvt) {
    const p = gasEvt.payload as ZeusEvent;
    if (snap.gasEth == null && p.balanceEth != null) snap.gasEth = p.balanceEth.toFixed(3);
    if (snap.gasUsd == null && p.balanceUsd != null) snap.gasUsd = "$" + p.balanceUsd.toFixed(2);
  }

  // ----- log do sistema (heartbeat agora vem do service_status, não de events) -----
  const sysTypes = new Set([
    "failure.cooldown_activated",
    "failure.cooldown_expired",
    "gas.alert",
    "gas.recovered",
    "pnl.kill_switch_triggered",
    "liquidator.boot",
    "liquidator.shutdown",
  ]);
  const sysLines = rows
    .filter((r) => sysTypes.has(r.type))
    .slice(0, 6)
    .map((r) => {
      const p = r.payload as ZeusEvent;
      let text = (p?.reason as string) || "";
      if (r.type === "gas.alert") text = text || `Gás baixo · ${p.balanceEth?.toFixed(3) ?? "?"} ETH`;
      else if (r.type.includes("cooldown")) text = text || `Cooldown · ${p.consecutiveFailures ?? "?"} falhas · ${p.cooldownSec ?? "?"}s`;
      else if (r.type.includes("kill_switch")) text = text || `Kill switch · perda 24h ${usd(p.loss24hUsd ?? 0)}`;
      return { time: hhmm(r.ts), color: colorFor(r.type), type: r.type, text: text || r.type };
    });
  // Linha sintética de heartbeat (estado mais fresco) no topo do log.
  const freshest = statuses.slice().sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
  if (freshest) {
    sysLines.unshift({
      time: hhmm(freshest.updated_at),
      color: "var(--gold)",
      type: "zeus.heartbeat",
      text: `Heartbeat ${freshest.service} · gás ${freshest.gas_reserve_eth?.toFixed(3) ?? "?"} ETH · uptime ${uptimeFromSec(freshest.uptime_sec ?? 0)}`,
    });
  }
  if (sysLines.length) snap.eventLog = sysLines.slice(0, 7);

  // ----- inteligência: drift sustentado real (de pnl.reconciled) -----
  const recon = rows.filter((r) => r.type === "pnl.reconciled").slice(0, 6);
  if (recon.length) {
    snap.driftAlarms = recon.map((r) => {
      const p = r.payload as ZeusEvent;
      const bps = Number(p.profitDeltaBps ?? 0);
      const mag = Math.abs(bps);
      const color = mag >= 100 ? "var(--red)" : mag >= 30 ? "var(--gold)" : "var(--green)";
      const cause = (p.attributionCause as string) || "—";
      return { color, text: `${p.protocol ?? "—"} · ${cause}`, bps: `${bps > 0 ? "+" : ""}${bps}bps` };
    });
  }

  // ----- item 1: falhas recentes (failure.recorded) — categoria + quem nos ganhou -----
  const failRows = rows.filter((r) => r.type === "failure.recorded").slice(0, 6);
  if (failRows.length) {
    snap.failures = failRows.map((r) => {
      const p = r.payload as ZeusEvent;
      const category = (p.failureCategory as string) || "—";
      const winner = (p.competitorAlias as string) || "";
      const lost = p.gasUsdLost != null ? `−$${Number(p.gasUsdLost).toFixed(2)} gás` : "";
      const detail = [winner ? `perdeu p/ ${winner}` : "", lost, (p.reason as string) || ""].filter(Boolean).join(" · ");
      return {
        time: hhmm(r.ts),
        color: category.includes("reverted") || category.includes("lost") ? "var(--red)" : "var(--gold)",
        protocol: r.protocol || (p.protocol as string) || "—",
        category,
        detail: detail || category,
      };
    });
  }

  // ----- item 2: pulso do radar (discovery, do heartbeat em service_status) -----
  // Prioriza o liquidator (motor que faz discovery); fallback = qualquer serviço com discovery.
  const discSvc = (byService("liquidator")?.discovery ? byService("liquidator") : statuses.find((s) => s.discovery))!;
  if (discSvc?.discovery) {
    const d = discSvc.discovery;
    snap.discovery = {
      service: discSvc.service,
      positions: d.positions,
      dispatched: d.dispatched,
      rejected: d.rejected,
      ago: ago(d.atIso),
    };
  }

  // ----- item 3: inteligência real (intel, do heartbeat) substitui o mock quando presente -----
  const intelSvc = byService("liquidator")?.intel ? byService("liquidator") : statuses.find((s) => s.intel);
  if (intelSvc?.intel) {
    snap.intel = { ...intelSvc.intel };
  }

  // ----- item 4: mini-cards por motor (PnL + ops 24h, derivado dos eventos tx.*) -----
  const startMs = startOfDay.getTime() - 23 * 60 * 60 * 1000; // janela ~24h
  const acc: Record<string, { netUsd: number; ops: number }> = {};
  for (const r of rows) {
    if (r.type !== "tx.confirmed" && r.type !== "tx.reverted_on_chain") continue;
    if (new Date(r.ts).getTime() < startMs) continue;
    const motor = motorOf(r.protocol);
    if (!motor) continue;
    const a = (acc[motor] ??= { netUsd: 0, ops: 0 });
    a.netUsd += r.net_profit_usd ?? (r.type === "tx.reverted_on_chain" ? -(r.gas_usd ?? 0) : 0);
    a.ops += 1;
  }
  // Sempre mostra os 3 cards (M1/M2/M3); motores sem evento ainda ficam zerados (honesto).
  snap.motorCards = ["motor1", "motor2", "motor3"].map((tag) => ({
    tag,
    label: MOTOR_LABEL[tag] ?? tag,
    netUsd: acc[tag]?.netUsd ?? 0,
    ops: acc[tag]?.ops ?? 0,
  }));

  return snap;
}
