import { MOCK } from "./mockData";
import type { LiveSnapshot, UiState } from "./types";

// ===== Helpers de formatação (portados do design) =====
function fmt(n: number, dec?: number) {
  const d = dec == null ? 2 : dec;
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function usd(n: number) {
  const s = n < 0 ? "−" : "+";
  return s + "$" + fmt(Math.abs(n));
}
export function usdp(n: number) {
  return "$" + fmt(Math.abs(n));
}
function col(n: number) {
  return n < 0 ? "var(--red)" : "var(--green)";
}

/** Constrói um path SVG a partir de uma série, normalizado num range comum. */
function pathFrom(vals: number[], gmin: number, grng: number, W: number, H: number, pad: number, close: boolean) {
  const n = vals.length;
  const pts = vals.map((v, i) => [pad + (i / (n - 1)) * (W - pad * 2), H - pad - ((v - gmin) / grng) * (H - pad * 2)] as const);
  let d = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L");
  if (close) d += ` L${(W - pad).toFixed(1)},${(H - pad).toFixed(1)} L${pad.toFixed(1)},${(H - pad).toFixed(1)} Z`;
  return d;
}

export function uptimeFromSec(totalSec: number) {
  const dd = Math.floor(totalSec / 86400);
  const hh = Math.floor((totalSec % 86400) / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  return `${dd}d ${String(hh).padStart(2, "0")}h ${String(mm).padStart(2, "0")}m`;
}

export type ViewModel = ReturnType<typeof buildViewModel>;

/**
 * Porte de `renderVals()` do design. `live` (opcional) sobrescreve os campos
 * dinâmicos com dados reais derivados dos eventos do Supabase.
 */
export function buildViewModel(ui: UiState, live?: LiveSnapshot | null) {
  const M = MOCK;
  const screen = ui.screen;

  // ---- uptime / clock (tick) ----
  const baseUp = 287400 + ui.tick;
  const uptime = uptimeFromSec(baseUp);
  const now = new Date();
  const clock =
    String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0");

  // ---- topbar / status ----
  const botStatus = live?.botStatus ?? M.botStatus;
  const runwayDays = live?.runwayDays ?? M.runwayDays;
  const adaptiveEv = live?.adaptiveEv ?? M.adaptiveEv;
  const gas = { eth: live?.gasEth ?? M.gas.eth, usd: live?.gasUsd ?? usdp(M.gas.usd) };

  // ---- KPIs ----
  const k = {
    today: live?.kpiToday != null ? usd(live.kpiToday) : usd(M.k.today),
    todayTx: live?.kpiTodayTx ?? M.k.todayTx,
    w7: usd(M.k.w7),
    w7delta: M.k.w7delta,
    m30: usd(M.k.m30),
    proj: usd(M.k.proj),
    winRate: live?.kpiWinRate ?? M.k.winRate,
    ok: live?.kpiOk ?? M.k.ok,
    fail: live?.kpiFail ?? M.k.fail,
    w14sum: usd(M.k.w14sum),
  };

  // ---- 14d bars ----
  const max14 = Math.max(...M.raw14.map(Math.abs));
  const pnl14 = M.raw14.map((v, i) => ({
    pct: ((Math.abs(v) / max14) * 100).toFixed(0),
    color: v < 0 ? "var(--red)" : i === M.raw14.length - 1 ? "var(--gold)" : "var(--green)",
    label: "D-" + (M.raw14.length - 1 - i) + ": " + usd(v),
  }));

  // ---- motors ----
  const motors = M.motors.map((m) => ({ ...m, pnl: usd(m.pnl) }));

  // ---- ticker ----
  const ticker =
    live?.ticker ??
    M.ticker.map((e) => {
      const sec = e.t + (ui.tick % 60);
      const lbl = sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m";
      return { color: e.color, text: e.text, time: lbl };
    });

  // ---- transactions ----
  const stMeta: Record<string, { label: string; color: string }> = {
    ok: { label: "CONFIRMED", color: "var(--green)" },
    rev: { label: "REVERTED", color: "var(--red)" },
    pre: { label: "PRE-REJECT", color: "var(--gold)" },
  };
  const explorer = process.env.NEXT_PUBLIC_EXPLORER_URL || "https://basescan.org";
  const sourceRows = live?.txRows ?? M.allRows;
  const q = (ui.query || "").toLowerCase();
  let filtered = sourceRows.filter((r) => ui.txFilter === "all" || r.st === ui.txFilter);
  if (q) filtered = filtered.filter((r) => ((r.hash || "") + r.protocol + r.pair).toLowerCase().includes(q));
  const txRows = filtered.map((r) => ({
    time: r.time,
    statusLabel: stMeta[r.st].label,
    statusColor: stMeta[r.st].color,
    protocol: r.protocol,
    pair: r.pair,
    net: r.st === "pre" ? "—" : usd(r.net),
    netColor: r.st === "pre" ? "var(--muted)" : col(r.net),
    gas: r.st === "pre" ? "—" : usdp(r.gas),
    drift: r.st === "pre" ? "—" : (r.drift > 0 ? "+" : "") + r.drift + "bps",
    driftColor: r.drift < -10 ? "var(--red)" : "var(--muted)",
    hashShort: r.hash ? r.hash + "…" : r.reason || "—",
    url: r.hash ? `${explorer}/tx/${r.hash}` : "#",
    mode: r.mode,
  }));
  const counts = live?.txCounts ?? {
    all: M.allRows.length,
    ok: M.allRows.filter((r) => r.st === "ok").length,
    rev: M.allRows.filter((r) => r.st === "rev").length,
    pre: M.allRows.filter((r) => r.st === "pre").length,
  };
  const filtDef: [UiState["txFilter"], string][] = [
    ["all", "Todas"],
    ["ok", "Confirmadas"],
    ["rev", "Revertidas"],
    ["pre", "Pré-rejeição"],
  ];
  const txFilters = filtDef.map(([id, label]) => ({
    id,
    label,
    count: counts[id],
    active: ui.txFilter === id,
    bg: ui.txFilter === id ? "var(--panel2)" : "transparent",
    fg: ui.txFilter === id ? "var(--text)" : "var(--muted)",
    border: ui.txFilter === id ? "var(--gold)" : "var(--border)",
  }));
  const txHeads = ["Hora", "Status", "Protocolo", "Par", "Net", "Gás", "Drift", "Hash", "Mode"];

  // ---- PnL ----
  const periodDef: [UiState["period"], string][] = [
    ["daily", "Diário"],
    ["weekly", "Semanal"],
    ["monthly", "Mensal"],
  ];
  const periods = periodDef.map(([id, label]) => ({
    id,
    label,
    active: ui.period === id,
    bg: ui.period === id ? "var(--gold)" : "transparent",
    fg: ui.period === id ? "var(--bg)" : "var(--muted)",
  }));
  const ser = M.pnlSeries[ui.period];
  const expSer = M.expSeries[ui.period];
  const allV = ser.concat(expSer);
  const gmin = Math.min(...allV);
  const gmax = Math.max(...allV);
  const grng = gmax - gmin || 1;
  const pnlLinePath = pathFrom(ser, gmin, grng, 600, 200, 12, false);
  const pnlAreaPath = pathFrom(ser, gmin, grng, 600, 200, 12, true);
  const pnlExpectedPath = pathFrom(expSer, gmin, grng, 600, 200, 12, false);
  const pnlk = {
    realized: usd(ser[ser.length - 1]),
    expected: usd(expSer[expSer.length - 1]),
    drift: "−118 bps",
    gas: usdp(1420),
  };
  const motorBreak = M.motorBreak.map((m) => ({ ...m, val: usd(m.val) }));
  const protoBreak = M.protoBreak.map((p) => ({ ...p, val: usd(p.val) }));

  // ---- wallet ----
  const wallet = { gas24h: usdp(M.wallet.gas24h), gas24hEth: M.wallet.gas24hEth, gas30d: usdp(M.wallet.gas30d), gas30dPct: M.wallet.gas30dPct };
  const whMax = Math.max(...M.whRaw);
  const walletHist = M.whRaw.map((v, i) => ({
    pct: ((v / whMax) * 100).toFixed(0),
    color: i === 7 || i === 18 ? "var(--gold)" : v < 0.45 ? "var(--red)" : "var(--cyan)",
  }));
  const gasAlerts = M.gasAlerts;

  // ---- intelligence ----
  const bribe = M.bribe;
  const ourBribe = M.ourBribe;
  const driftAlarms = M.driftAlarms;
  const competitors = M.competitors;
  const postmortem = M.postmortem;
  const calib = M.calib;
  const edgePairs = M.edgePairs;

  // ---- health ----
  const components = M.components;
  const cooldowns = M.cooldowns;
  const latAll = M.latP50.concat(M.latP95);
  const lmin = Math.min(...latAll);
  const lmax = Math.max(...latAll);
  const lrng = lmax - lmin || 1;
  const latP50Path = pathFrom(M.latP50, lmin, lrng, 600, 150, 8, false);
  const latP95Path = pathFrom(M.latP95, lmin, lrng, 600, 150, 8, false);
  const ks = { loss: usd(M.ks.loss), limit: usdp(M.ks.limit), pct: M.ks.pct, last: M.ks.last };
  const healthKpis = [
    { label: "Kill switch", isStatus: true, isVal: false, dot: "var(--green)", big: "Armado", unit: "", color: "var(--text)", sub: "limite 24h: −$2.000" },
    { label: "Uptime", isStatus: false, isVal: true, dot: "", big: uptime, unit: "", color: "var(--text)", sub: "sem restart" },
    { label: "Dispatch p50", isStatus: false, isVal: true, dot: "", big: "142", unit: "ms", color: "var(--text)", sub: "alvo <200ms" },
    { label: "Dispatch p95", isStatus: false, isVal: true, dot: "", big: "410", unit: "ms", color: "var(--gold)", sub: "alvo <500ms" },
    { label: "Reorgs · 24h", isStatus: false, isVal: true, dot: "", big: "3", unit: "", color: "var(--text2)", sub: "prof. máx. 2" },
    { label: "Taxa de erro", isStatus: false, isVal: true, dot: "", big: "1.3%", unit: "", color: "var(--cyan)", sub: "6 de 477 ops" },
  ];
  const eventLog = live?.eventLog ?? M.eventLog;

  // ---- reports ----
  const rp = M.repByPeriod[ui.period];
  const rep = {
    net: usd(rp.net),
    win: rp.win,
    ops: rp.ops,
    gas: usdp(rp.gas),
    drift: rp.drift,
    bestMotor: rp.bestMotor,
    summary: `No período, o ZEUS executou ${rp.ops} operações com win-rate de ${rp.win}, gerando ${usd(rp.net)} líquidos na Base mainnet. O Motor 2 (Arbitragem) liderou a contribuição de lucro, enquanto o gás representou ${M.wallet.gas30dPct} do bruto. O drift médio de ${rp.drift} indica execução ligeiramente abaixo do esperado — atribuível a competição de bribe em WETH/USDC. Runway de gás saudável em ${runwayDays} dias.`,
  };

  // ---- settings ----
  const notif = ui.notif;
  const notifRules = M.notifMeta.map(([key, label, value]) => ({
    key,
    label,
    value,
    on: !!notif[key],
    trackBg: notif[key] ? "var(--green)" : "var(--border2)",
    knobLeft: notif[key] ? "21px" : "3px",
  }));
  const chans = ui.chans;
  const channels = M.chanMeta.map(([key, label, sub]) => ({
    key,
    label,
    sub,
    on: !!chans[key],
    trackBg: chans[key] ? "var(--green)" : "var(--border2)",
    knobLeft: chans[key] ? "21px" : "3px",
  }));

  return {
    uptime,
    clock,
    botStatus,
    runwayDays,
    adaptiveEv,
    gas,
    k,
    pnl14,
    motors,
    insights: M.insights,
    ticker,
    txFilters,
    txHeads,
    txRows,
    periods,
    pnlk,
    pnlLinePath,
    pnlAreaPath,
    pnlExpectedPath,
    motorBreak,
    protoBreak,
    wallet,
    walletHist,
    gasAlerts,
    bribe,
    ourBribe,
    driftAlarms,
    competitors,
    postmortem,
    calib,
    edgePairs,
    components,
    cooldowns,
    healthKpis,
    latP50Path,
    latP95Path,
    ks,
    eventLog,
    rep,
    reportPeriodLabel: rp.label,
    reportRange: rp.range,
    notifRules,
    channels,
  };
}
